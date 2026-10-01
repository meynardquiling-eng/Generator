/**
 * Training Drill — Form Bridge (Google Apps Script).
 *
 * The trainer dashboard is a claude.ai Artifact and cannot call the Google Forms API.
 * This script runs in a trainer's Google account and does the Google-side work,
 * communicating with the dashboard only through one PRIVATE Drive folder:
 *
 *   dashboard writes  drillform-request__<drillId>__<specHash>.json   (trainee-safe form spec)
 *   bridge writes     drillform-result__<drillId>.json                 (formId, URLs, item IDs)
 *   bridge writes     drillform-responses__<drillId>.json              (submissions, refreshed every run)
 *   dashboard writes  drill-sources-request__<ts>.json                 (asks for a source export)
 *   bridge writes     drill-sources__index.json + drill-sources__part-NNN.json
 *
 * Idempotency: one form per drill ID. The form ID is saved in Script Properties right
 * after FormApp.create(); if that is lost, the bridge finds the form by its Drive title
 * and the "Drill ID: ..." marker in its description before ever creating another.
 * Items are matched by title, so a run interrupted half-way finishes the same form.
 *
 * Setup: paste into a new Apps Script project, run setupBridge() once, copy the logged
 * folder ID into the dashboard's Settings, and share the folder (Editor) with trainers only.
 */

var FOLDER_PROP = 'BRIDGE_FOLDER_ID';
var DEFAULT_SOURCE_DOC_ID = '1igeJMGuPe2t4ajDmQTOOitb5amy68gY6q4ImWVoaNf8';
var EXPORT_DAYS = 45;
var SOURCE_PART_CHARS = 400000;
var SECTION_MAX_CHARS = 8000;

function setupBridge() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty(FOLDER_PROP);
  if (!folderId) {
    folderId = DriveApp.createFolder('Training Drill Form Bridge (trainers only)').getId();
    props.setProperty(FOLDER_PROP, folderId);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runBridge') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runBridge').timeBased().everyMinutes(5).create();
  Logger.log('Form Bridge folder ID (paste into dashboard Settings): ' + folderId);
  return folderId;
}

function runBridge() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty(FOLDER_PROP));
    processFormRequests_(folder);
    exportAllResponses_(folder);
    processSourceRequests_(folder);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Form requests

function processFormRequests_(folder) {
  var latest = {};
  var it = folder.searchFiles("title contains 'drillform-request__' and trashed = false");
  while (it.hasNext()) {
    var f = it.next();
    var m = /^drillform-request__(.+)__([0-9a-f]+)\.json$/.exec(f.getName());
    if (!m) continue;
    var cur = latest[m[1]];
    if (!cur || f.getDateCreated() > cur.file.getDateCreated()) latest[m[1]] = { file: f, drillId: m[1], specHash: m[2] };
  }
  Object.keys(latest).forEach(function (drillId) {
    var req = latest[drillId];
    var resultName = 'drillform-result__' + drillId + '.json';
    var prev = readJson_(folder, resultName);
    if (prev && prev.status === 'CREATED' && prev.specHash === req.specHash) return;
    try {
      var body = JSON.parse(req.file.getBlob().getDataAsString());
      var spec = body.spec;
      validateSpec_(spec, drillId, req.specHash);
      var result = ensureForm_(spec, folder);
      result.status = 'CREATED';
      result.specHash = req.specHash;
      result.drillId = drillId;
      result.processedAt = new Date().toISOString();
      writeJson_(folder, resultName, result);
      exportResponses_(folder, drillId, result.formId, true);
    } catch (e) {
      writeJson_(folder, resultName, {
        drillId: drillId, specHash: req.specHash, status: 'ERROR',
        error: String(e && e.message || e), processedAt: new Date().toISOString()
      });
    }
  });
}

// Defense in depth: the dashboard only sends trainee-safe specs; refuse anything else.
function validateSpec_(spec, drillId, specHash) {
  if (!spec || spec.drillId !== drillId) throw new Error('Request drill ID does not match its file name.');
  if (spec.specHash && spec.specHash !== specHash) throw new Error('Request spec hash does not match its file name.');
  if (String(spec.description || '').indexOf('Drill ID: ' + drillId) === -1) throw new Error('Form description is missing the drill marker.');
  var raw = JSON.stringify(spec.items || []);
  ['"trainer"', '"rationale"', '"correctAnswer"', '"coachingNotes"', '"scoring"'].forEach(function (k) {
    if (raw.indexOf(k) !== -1) throw new Error('Spec contains trainer-only field ' + k + '; refusing to build the form.');
  });
  if (!spec.items || !spec.items.length) throw new Error('Spec has no items.');
}

function ensureForm_(spec, folder) {
  var props = PropertiesService.getScriptProperties();
  var key = 'form:' + spec.drillId;
  var form = openForm_(props.getProperty(key)) || findFormByMarker_(spec);
  if (!form) {
    form = FormApp.create(spec.title);
    // Record immediately: if anything below fails, the next run reuses this form.
    props.setProperty(key, form.getId());
    moveToFolder_(form.getId(), folder);
  } else {
    props.setProperty(key, form.getId());
  }
  applySettings_(form, spec);
  var items = ensureItems_(form, spec);
  var sheet = ensureResponseSheet_(form, spec, folder);
  return {
    formId: form.getId(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl(),
    responseSheetId: sheet.getId(),
    responseSheetUrl: sheet.getUrl(),
    items: items
  };
}

function openForm_(formId) {
  if (!formId) return null;
  try {
    if (DriveApp.getFileById(formId).isTrashed()) return null;
    return FormApp.openById(formId);
  } catch (e) {
    return null;
  }
}

function findFormByMarker_(spec) {
  var marker = 'Drill ID: ' + spec.drillId;
  var it = DriveApp.searchFiles("mimeType = 'application/vnd.google-apps.form' and title contains '" +
    spec.drillId.replace(/'/g, "\\'") + "' and trashed = false");
  while (it.hasNext()) {
    var form = openForm_(it.next().getId());
    if (form && String(form.getDescription()).indexOf(marker) !== -1) return form;
  }
  return null;
}

function applySettings_(form, spec) {
  var s = spec.settings || {};
  form.setTitle(spec.title).setDescription(spec.description);
  if (s.collectVerifiedEmail) {
    try {
      form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED);
    } catch (e) {
      form.setCollectEmail(true);
    }
    form.setLimitOneResponsePerUser(!!s.limitOneResponsePerUser);
  }
  form.setAllowResponseEdits(false);
  form.setPublishingSummary(false);
  form.setShowLinkToRespondAgain(false);
  form.setIsQuiz(false);
  form.setProgressBar(true);
  form.setAcceptingResponses(true);
  if (s.confirmationMessage) form.setConfirmationMessage(s.confirmationMessage);
}

function ensureItems_(form, spec) {
  var existing = form.getItems();
  var existingTitles = existing.map(function (i) { return i.getTitle(); });
  var specTitles = spec.items.map(function (i) { return i.title; });
  var inOrder = existingTitles.length === specTitles.length && existingTitles.every(function (t, i) { return t === specTitles[i]; });
  if (!inOrder) {
    if (form.getResponses().length === 0) {
      existing.forEach(function (item) { form.deleteItem(item); });
      spec.items.forEach(function (it) { addItem_(form, it); });
    } else {
      // Never delete items that already hold answers; only add what is missing.
      spec.items.forEach(function (it) {
        if (existingTitles.indexOf(it.title) === -1) addItem_(form, it);
      });
    }
  }
  var byTitle = {};
  spec.items.forEach(function (it) { byTitle[it.title] = it; });
  var map = [];
  form.getItems().forEach(function (item) {
    var s = byTitle[item.getTitle()];
    if (s && s.kind === 'QUESTION') map.push({ key: s.key, itemId: String(item.getId()), title: item.getTitle() });
  });
  var expected = spec.items.filter(function (i) { return i.kind === 'QUESTION'; }).length;
  if (map.length !== expected) throw new Error('Form has ' + map.length + ' of ' + expected + ' questions after build.');
  return map;
}

function addItem_(form, it) {
  var item;
  if (it.kind === 'SECTION') {
    return form.addPageBreakItem().setTitle(it.title).setHelpText(it.helpText || '');
  }
  if (it.type === 'CHECKBOX') item = form.addCheckboxItem().setChoiceValues(it.choices);
  else if (it.type === 'MULTIPLE_CHOICE') item = form.addMultipleChoiceItem().setChoiceValues(it.choices);
  else if (it.type === 'PARAGRAPH') item = form.addParagraphTextItem();
  else item = form.addTextItem();
  item.setTitle(it.title).setRequired(!!it.required);
  if (it.helpText) item.setHelpText(it.helpText);
  return item;
}

function ensureResponseSheet_(form, spec, folder) {
  try {
    var id = form.getDestinationId();
    if (id) return SpreadsheetApp.openById(id);
  } catch (e) { /* no destination yet */ }
  var props = PropertiesService.getScriptProperties();
  var key = 'sheet:' + spec.drillId;
  var ss = null;
  var saved = props.getProperty(key);
  if (saved) {
    try { ss = SpreadsheetApp.openById(saved); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(spec.title + ' (Responses)');
    props.setProperty(key, ss.getId());
    moveToFolder_(ss.getId(), folder);
  }
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  return ss;
}

// ---------------------------------------------------------------------------
// Responses

function exportAllResponses_(folder) {
  var cutoff = Date.now() - EXPORT_DAYS * 24 * 3600 * 1000;
  var it = folder.searchFiles("title contains 'drillform-result__' and trashed = false");
  while (it.hasNext()) {
    var f = it.next();
    var r;
    try { r = JSON.parse(f.getBlob().getDataAsString()); } catch (e) { continue; }
    if (r.status !== 'CREATED' || !r.formId) continue;
    if (r.processedAt && new Date(r.processedAt).getTime() < cutoff) continue;
    exportResponses_(folder, r.drillId, r.formId, false);
  }
}

function exportResponses_(folder, drillId, formId, force) {
  var props = PropertiesService.getScriptProperties();
  var name = 'drillform-responses__' + drillId + '.json';
  var payload;
  try {
    var form = FormApp.openById(formId);
    var responses = form.getResponses();
    var fingerprint = responses.length + '|' + (responses.length ? responses[responses.length - 1].getTimestamp().getTime() : 0);
    if (!force && props.getProperty('exported:' + drillId) === fingerprint) return;
    payload = {
      drillId: drillId, formId: formId, generatedAt: new Date().toISOString(), source: 'FORM',
      responses: responses.map(function (resp) {
        var email = '';
        try { email = resp.getRespondentEmail(); } catch (e) { email = ''; }
        return {
          responseId: resp.getId(),
          submittedAt: resp.getTimestamp().toISOString(),
          respondentEmail: email || null,
          answers: resp.getItemResponses().map(function (ir) {
            return { itemId: String(ir.getItem().getId()), title: ir.getItem().getTitle(), value: ir.getResponse() };
          })
        };
      })
    };
    writeJson_(folder, name, payload);
    props.setProperty('exported:' + drillId, fingerprint);
  } catch (e) {
    // Fallback: read the linked response sheet by header names.
    var sheetId = props.getProperty('sheet:' + drillId);
    if (!sheetId) return;
    var values = SpreadsheetApp.openById(sheetId).getSheets()[0].getDataRange().getValues();
    if (!values.length) return;
    payload = {
      drillId: drillId, formId: formId, generatedAt: new Date().toISOString(), source: 'SHEET',
      sheet: {
        headers: values[0].map(String),
        rows: values.slice(1).map(function (row) {
          return row.map(function (c) { return c instanceof Date ? c.toISOString() : c; });
        })
      },
      error: String(e && e.message || e)
    };
    writeJson_(folder, name, payload);
  }
}

// ---------------------------------------------------------------------------
// Source export (Knowledge Library -> heading-level sections)

function processSourceRequests_(folder) {
  var it = folder.searchFiles("title contains 'drill-sources-request__' and trashed = false");
  var reqs = [];
  while (it.hasNext()) reqs.push(it.next());
  if (!reqs.length) return;
  reqs.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  var docId = DEFAULT_SOURCE_DOC_ID;
  try {
    var body = JSON.parse(reqs[0].getBlob().getDataAsString());
    if (body.docId) docId = body.docId;
  } catch (e) { /* use default */ }
  exportSources_(folder, docId);
  reqs.forEach(function (f) { f.setTrashed(true); });
}

function exportSources_(folder, docId) {
  var doc = DocumentApp.openById(docId);
  var sections = [];
  flattenTabs_(doc.getTabs()).forEach(function (tab) {
    var url = 'https://docs.google.com/document/d/' + docId + '/edit?tab=' + tab.getId();
    var body = tab.asDocumentTab().getBody();
    var stack = [];
    var current = null;
    var seen = {};
    function flush() {
      if (!current || !current.text.trim()) return;
      var path = [tab.getTitle()].concat(current.path).join(' > ');
      splitText_(current.text.trim(), SECTION_MAX_CHARS).forEach(function (part, i, arr) {
        var base = path + (arr.length > 1 ? ' (part ' + (i + 1) + ')' : '');
        seen[base] = (seen[base] || 0) + 1;
        sections.push({
          sectionId: 'KL-' + digest_(tab.getId() + '|' + base + '|' + seen[base]),
          sourceType: 'KNOWLEDGE_LIBRARY', title: doc.getName(),
          heading: current.path[current.path.length - 1] || tab.getTitle(),
          path: base, url: url, text: part
        });
      });
    }
    for (var i = 0; i < body.getNumChildren(); i++) {
      var el = body.getChild(i);
      var type = el.getType();
      if (type === DocumentApp.ElementType.PARAGRAPH) {
        var p = el.asParagraph();
        var level = headingLevel_(p.getHeading());
        var text = p.getText();
        if (level && text.trim()) {
          flush();
          stack = stack.slice(0, level - 1);
          stack[level - 1] = text.trim();
          current = { path: stack.filter(Boolean).slice(), text: '' };
          continue;
        }
        if (!current) current = { path: [], text: '' };
        if (text.trim()) current.text += text + '\n';
      } else if (type === DocumentApp.ElementType.LIST_ITEM) {
        if (!current) current = { path: [], text: '' };
        current.text += '• ' + el.asListItem().getText() + '\n';
      } else if (type === DocumentApp.ElementType.TABLE) {
        if (!current) current = { path: [], text: '' };
        var table = el.asTable();
        for (var r = 0; r < table.getNumRows(); r++) {
          var row = table.getRow(r);
          var cells = [];
          for (var c = 0; c < row.getNumCells(); c++) cells.push(row.getCell(c).getText().replace(/\s+/g, ' ').trim());
          current.text += cells.join(' | ') + '\n';
        }
      }
    }
    flush();
  });

  var parts = [];
  var cur = [], size = 0;
  sections.forEach(function (s) {
    var len = JSON.stringify(s).length;
    if (size + len > SOURCE_PART_CHARS && cur.length) { parts.push(cur); cur = []; size = 0; }
    cur.push(s);
    size += len;
  });
  if (cur.length) parts.push(cur);
  var names = parts.map(function (p, i) {
    var name = 'drill-sources__part-' + ('000' + (i + 1)).slice(-3) + '.json';
    writeJson_(folder, name, { sections: p });
    return name;
  });
  writeJson_(folder, 'drill-sources__index.json', {
    generatedAt: new Date().toISOString(), docId: docId, docTitle: doc.getName(),
    sectionCount: sections.length, parts: names
  });
}

function flattenTabs_(tabs) {
  var out = [];
  tabs.forEach(function (t) {
    out.push(t);
    out = out.concat(flattenTabs_(t.getChildTabs()));
  });
  return out;
}

function headingLevel_(h) {
  var H = DocumentApp.ParagraphHeading;
  if (h === H.TITLE || h === H.HEADING1) return 1;
  if (h === H.HEADING2) return 2;
  if (h === H.HEADING3) return 3;
  if (h === H.HEADING4) return 4;
  return 0;
}

function splitText_(text, max) {
  if (text.length <= max) return [text];
  var out = [];
  var rest = text;
  while (rest.length > max) {
    var cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

// ---------------------------------------------------------------------------
// Drive helpers

function readJson_(folder, name) {
  var it = folder.getFilesByName(name);
  if (!it.hasNext()) return null;
  try { return JSON.parse(it.next().getBlob().getDataAsString()); } catch (e) { return null; }
}

function writeJson_(folder, name, obj) {
  var json = JSON.stringify(obj);
  var it = folder.getFilesByName(name);
  if (it.hasNext()) {
    it.next().setContent(json);
  } else {
    folder.createFile(name, json, 'application/json');
  }
}

function moveToFolder_(fileId, folder) {
  try { DriveApp.getFileById(fileId).moveTo(folder); } catch (e) { /* stays in My Drive */ }
}

function digest_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 12);
}
