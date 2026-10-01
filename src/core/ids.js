// Drill and scenario identifiers. These IDs are the join keys between the answer key,
// the Google Form items and the submitted responses; text, names and timestamps are not.

// APPROVE-DENY-2026-10-01-001
function makeDrillId(prefix, dateStr, existingIds) {
  var base = prefix + '-' + dateStr + '-';
  var max = 0;
  (existingIds || []).forEach(function (id) {
    if (String(id).indexOf(base) === 0) {
      var n = parseInt(String(id).slice(base.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return base + pad3(max + 1);
}

// AD-001. Unique within a drill; never reused after removal (drill.nextScenarioSeq only grows).
function makeScenarioId(prefix, seq) {
  return prefix + '-' + pad3(seq);
}

// Globally unique scenario key: APPROVE-DENY-2026-10-01-001/AD-001
function makeScenarioUid(drillId, scenarioId) {
  return drillId + '/' + scenarioId;
}

function makeAnswerId(drillId, responseId, scenarioId, questionKey) {
  return [drillId, responseId, scenarioId, questionKey].join('|');
}

function makeFormItemKey(drillId, itemKey) {
  return drillId + '|' + itemKey;
}

// Visible prefix on every form question, e.g. "AD-003 · Q2". Doubles as a fallback
// mapping key when only the response sheet headers are available.
function questionTag(scenarioId, questionIndex) {
  return scenarioId + ' · Q' + (questionIndex + 1);
}

var QUESTION_TAG_RE = /^\s*([A-Z][A-Z0-9]*-\d{3})\s*·\s*Q(\d+)\b/;

function parseQuestionTag(title) {
  var m = QUESTION_TAG_RE.exec(String(title || ''));
  if (!m) return null;
  return { scenarioId: m[1], questionNumber: parseInt(m[2], 10) };
}

function traineeIdFor(email, name) {
  if (!isBlank(email)) return 'email:' + String(email).trim().toLowerCase();
  if (!isBlank(name)) return 'name:' + normalizeText(name);
  return 'unknown';
}
