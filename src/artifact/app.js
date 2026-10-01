// Trainer dashboard UI. Trainees never open this page; they answer in Google Forms.

var S = {
  view: 'today', drillId: null, tab: 'scenarios',
  drills: [], bundle: null, settings: null, report: null, reportType: '',
  catalog: [], snippets: [], sections: null, sourceFilter: '',
  csq: { channelId: '', channelName: '', messages: [], search: [] },
  editing: {}, confirmRemove: null, respTrainee: '',
  busy: null, error: null, ready: false, fatal: null,
  caps: { db: false, sample: false, mcp: false, user: false }, canWrite: null, actor: 'unknown', names: {}
};
var svc = null;
var userCap = null;

var VIEWS = [['today', 'Today'], ['drills', 'Drills'], ['coaching', 'Coaching'], ['sources', 'Sources'], ['settings', 'Settings']];
var STEPS = ['DRAFT', 'GENERATED', 'TRAINER_REVIEW', 'APPROVED', 'FORM_CREATING', 'FORM_CREATED', 'SENT', 'RESPONSES_RECEIVED', 'UNDER_REVIEW', 'COMPLETED'];
var STEP_LABEL = { DRAFT: 'Draft', GENERATED: 'Generated', TRAINER_REVIEW: 'Trainer review', APPROVED: 'Approved', FORM_CREATING: 'Form requested', FORM_CREATED: 'Form created', SENT: 'Sent', RESPONSES_RECEIVED: 'Responses in', UNDER_REVIEW: 'Under review', COMPLETED: 'Completed' };
var GAP_LABEL = { INCORRECT_DECISION: 'Incorrect decision', INCORRECT_PROCESS: 'Incorrect process', INCORRECT_TAG: 'Incorrect tag', INCORRECT_CHECKLIST: 'Incorrect checklist', MISSING_ACCOUNT_DETAIL: 'Missing account detail', WEAK_REASONING: 'Weak reasoning', POLICY_MISREAD: 'Policy misread', OTHER: 'Other' };

// ---------------------------------------------------------------- helpers

function h(tag, attrs) {
  var el = document.createElement(tag);
  attrs = attrs || {};
  Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v == null || v === false) return;
    if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  });
  for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
  return el;
}
function append(el, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
  el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
}
function pill(text, kind) { return h('span', { class: 'pill' + (kind ? ' ' + kind : '') }, text); }
function btn(label, onClick, opts) {
  opts = opts || {};
  return h('button', { class: 'btn' + (opts.primary ? ' primary' : '') + (opts.danger ? ' danger' : ''), type: 'button', disabled: opts.disabled || (opts.write !== false && S.canWrite === false), onclick: onClick, title: opts.title }, label);
}
function field(label, input) { return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input); }
function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
function checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }
function lines(text) { return String(text || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean); }
function fmtDate(iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function who(id) { if (!id) return '—'; if (id === S.actor) return 'you'; return S.names[id] || 'another trainer'; }
function statusPill(status) {
  var kind = { COMPLETED: 'ok', APPROVED: 'accent', FORM_CREATED: 'accent', SENT: 'accent', RESPONSES_RECEIVED: 'warn', UNDER_REVIEW: 'warn', FORM_CREATING: 'warn' }[status] || '';
  return pill(STEP_LABEL[status] || status, kind);
}
function answerText(a) { if (Array.isArray(a)) return a.length ? a.join(' + ') : '(none selected)'; return a == null || a === '' ? '(blank)' : String(a); }
function today() { return new Date().toLocaleDateString('en-CA'); }

function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.hidden = true; }, 3500);
}

// Shows the busy state without re-rendering the page, so form values the action is
// about to read are still on screen.
function showBusy() {
  var bar = document.getElementById('busy');
  bar.textContent = S.busy ? S.busy + '…' : '';
  bar.hidden = !S.busy;
  document.body.classList.toggle('is-busy', !!S.busy);
}

async function act(label, fn, okMsg) {
  if (S.busy) return null;
  S.busy = label;
  S.error = null;
  showBusy();
  try {
    var r = await fn();
    var msg = typeof okMsg === 'function' ? okMsg(r) : okMsg;
    if (msg) toast(msg);
    return r;
  } catch (e) {
    S.error = errorText(e);
    return null;
  } finally {
    S.busy = null;
    render();
  }
}

function copyText(text) {
  try {
    navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, function () { toast('Copy failed. Select the link and copy it.'); });
  } catch (e) { toast('Copy failed. Select the link and copy it.'); }
}

async function loadDrills() { S.drills = await svc.listDrills(); }
async function loadBundle() { if (S.drillId) S.bundle = await svc.getDrillBundle(S.drillId); await resolveNames(); }
async function loadSettings() { S.settings = await svc.getSettings(); }

async function resolveNames() {
  if (!userCap || !S.bundle) return;
  var ids = uniq((S.bundle.drill.audit || []).map(function (a) { return a.by; }).concat([S.bundle.drill.createdBy]).filter(function (x) { return x && x !== S.actor && !S.names[x]; }));
  if (!ids.length) return;
  try {
    var ps = await userCap.profiles(ids);
    ids.forEach(function (id) { if (ps[id] && ps[id].name) S.names[id] = ps[id].name; });
  } catch (e) { /* names are a nicety */ }
}

async function openDrill(drillId, tab) {
  S.view = 'drill';
  S.drillId = drillId;
  S.tab = tab || 'scenarios';
  S.editing = {};
  await act('Opening ' + drillId, async function () {
    await loadBundle();
    if (S.bundle.drill.status === 'GENERATED') { await svc.beginReview(drillId); await loadBundle(); }
  });
}

function go(view) {
  S.view = view;
  S.error = null;
  render();
  if (view === 'drills' || view === 'today') act('Loading drills', loadDrills);
  if (view === 'coaching') act('Building the coaching report', async function () { S.report = await svc.coachingReport({ drillType: S.reportType || undefined }); });
  if (view === 'sources') act('Loading sources', async function () {
    S.sections = await svc.getAllSections();
    S.catalog = await svc.listCatalog();
    S.snippets = await svc.listSnippets();
    await loadSettings();
  });
  if (view === 'settings') act('Loading settings', loadSettings);
}

// ---------------------------------------------------------------- render

function render() {
  var nav = document.getElementById('nav');
  nav.replaceChildren.apply(nav, VIEWS.map(function (v) {
    var current = S.view === v[0] || (v[0] === 'drills' && S.view === 'drill');
    return h('button', { type: 'button', 'aria-current': current ? 'page' : null, onclick: function () { go(v[0]); } }, v[1]);
  }));
  showBusy();
  var app = document.getElementById('app');
  var kids = [];
  if (S.fatal) {
    app.replaceChildren(h('section', { class: 'panel' }, h('h2', null, 'The dashboard cannot start here'), h('p', null, S.fatal)));
    return;
  }
  if (!S.ready) return;
  if (S.canWrite === false) kids.push(h('div', { class: 'notice warn' }, 'You have view-only access. Ask the dashboard owner for Contributor access to generate, edit or score drills.'));
  if (S.error) kids.push(h('div', { class: 'notice bad row spread' }, h('span', null, S.error), btn('Dismiss', function () { S.error = null; render(); }, { write: false })));
  var view = { today: viewToday, drills: viewDrills, drill: viewDrill, coaching: viewCoaching, sources: viewSources, settings: viewSettings }[S.view];
  kids.push(view());
  app.replaceChildren.apply(app, kids);
}

// ---------------------------------------------------------------- Today

function setupIssues() {
  var issues = [];
  if (!S.caps.sample) issues.push('Claude is not available on this view, so scenarios must be written manually.');
  if (!S.caps.mcp) issues.push('Connectors are not available on this view. Google Forms and source imports need the Google Drive connector.');
  if (S.settings && isBlank(S.settings.bridgeFolderId)) issues.push('Form Bridge folder is not set. Open Settings and follow the bridge setup steps.');
  if (S.settings && !S.settings.sourcesMeta) issues.push('Knowledge Library sections have not been imported yet. Open Sources and import them.');
  return issues;
}

function viewToday() {
  var t = today();
  var todays = S.drills.filter(function (d) { return d.drillType === 'APPROVE_DENY' && d.drillDate === t; });
  var issues = setupIssues();
  var ad = getDrillType('APPROVE_DENY');
  return h('div', { class: 'stack' },
    issues.length ? h('section', { class: 'panel' }, h('h2', null, 'Finish setup'), h('ul', null, issues.map(function (i) { return h('li', null, i); }))) : null,
    h('section', { class: 'panel' },
      h('div', { class: 'row spread' }, h('h2', null, 'Today’s Approve or Deny drill'), h('span', { class: 'muted mono' }, t)),
      h('p', { class: 'muted' }, ad.defaults.scenarioCount + ' complex membership tickets, ' + ad.defaults.targetMinutes + '-minute target. Generate, review, approve, then create the Google Form and share its link with trainees.'),
      todays.length
        ? h('div', { class: 'stack' }, todays.map(function (d) {
            return h('div', { class: 'row spread panel flat' },
              h('div', { class: 'row' }, h('span', { class: 'mono' }, d.drillId), statusPill(d.status), h('span', { class: 'muted small' }, d.submissions + ' submissions')),
              btn('Open', function () { openDrill(d.drillId); }, { write: false }));
          }), h('div', { class: 'row' }, btn('Start another for today', startToday)))
        : h('div', { class: 'row' }, btn('Start today’s drill', startToday, { primary: true }))
    ),
    viewNewDrill()
  );
}

async function startToday() {
  var d = await act('Creating today’s drill', function () { return svc.createDrill({ drillType: 'APPROVE_DENY' }); });
  if (!d) return;
  await openDrill(d.drillId);
  if (S.caps.sample) generateAll(d.drillId);
}

function viewNewDrill() {
  var types = listDrillTypeSummaries();
  var sel = h('select', { id: 'nd-type', onchange: function () {
    var t = types.filter(function (x) { return x.type === val('nd-type'); })[0];
    document.getElementById('nd-count').value = t.defaults.scenarioCount;
    document.getElementById('nd-min').value = t.defaults.targetMinutes;
    document.getElementById('nd-diff').value = t.defaults.difficulty;
  } }, types.map(function (t) { return h('option', { value: t.type }, t.name); }));
  return h('section', { class: 'panel' },
    h('h2', null, 'New drill'),
    h('div', { class: 'fields' },
      field('Drill type', sel),
      field('Scenarios', h('input', { id: 'nd-count', type: 'number', min: '1', max: '25', value: String(types[0].defaults.scenarioCount) })),
      field('Difficulty', h('select', { id: 'nd-diff' }, ['EASY', 'MEDIUM', 'HARD'].map(function (d) { return h('option', { value: d, selected: d === types[0].defaults.difficulty }, d.charAt(0) + d.slice(1).toLowerCase()); }))),
      field('Target minutes', h('input', { id: 'nd-min', type: 'number', min: '1', value: String(types[0].defaults.targetMinutes) })),
      field('Title (optional)', h('input', { id: 'nd-title', placeholder: 'Shown as the form title' }))
    ),
    h('div', { class: 'row' }, btn('Create drill', async function () {
      var d = await act('Creating drill', function () {
        return svc.createDrill({ drillType: val('nd-type'), scenarioCount: val('nd-count'), difficulty: val('nd-diff'), targetMinutes: val('nd-min'), title: val('nd-title') || undefined });
      });
      if (d) openDrill(d.drillId);
    }, { primary: true }))
  );
}

// ---------------------------------------------------------------- Drills list

function viewDrills() {
  if (!S.drills.length) {
    return h('section', { class: 'panel empty' }, h('h2', null, 'No drills yet'), h('p', null, 'Create one from Today. Each drill gets an ID like APPROVE-DENY-2026-10-01-001 that ties its form, responses and scores together.'), btn('Go to Today', function () { go('today'); }, { write: false }));
  }
  return h('section', { class: 'panel' },
    h('h2', null, 'Drills'),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Drill ID', 'Type', 'Created', 'Scenarios', 'Google Form', 'Submissions', 'Status'].map(function (c) { return h('th', null, c); }))),
      h('tbody', null, S.drills.map(function (d) {
        return h('tr', { class: 'click', tabindex: '0', onclick: function () { openDrill(d.drillId); }, onkeydown: function (e) { if (e.key === 'Enter') openDrill(d.drillId); } },
          h('td', { class: 'mono' }, d.drillId),
          h('td', null, getDrillType(d.drillType).name),
          h('td', null, fmtDate(d.createdAt)),
          h('td', null, String(d.scenarioCount)),
          h('td', null, d.formStatus === 'NONE' ? h('span', { class: 'muted' }, 'Not created') : pill(d.formStatus === 'CREATED' ? 'Created' : 'Requested', d.formStatus === 'CREATED' ? 'accent' : 'warn')),
          h('td', null, d.submissions ? d.submissions + ' from ' + d.trainees + (d.pendingReview ? ' · ' + d.pendingReview + ' to score' : '') : '—'),
          h('td', null, statusPill(d.status)));
      }))
    ))
  );
}

// ---------------------------------------------------------------- Drill workspace

async function generateAll(drillId) {
  if (S.busy) return;
  try {
    while (true) {
      var b = await svc.getDrillBundle(drillId);
      var active = activeScenarios(b.scenarios).length;
      if (active >= b.drill.config.scenarioCount) break;
      S.busy = 'Generating scenario ' + (active + 1) + ' of ' + b.drill.config.scenarioCount + ' (each takes up to a minute)';
      S.error = null;
      showBusy();
      await svc.generateNextScenario(drillId);
      S.bundle = await svc.getDrillBundle(drillId);
    }
    toast('Scenarios generated. Review each one before approving.');
  } catch (e) {
    S.error = errorText(e);
  } finally {
    S.busy = null;
    if (S.drillId === drillId) await loadBundle().catch(function () {});
    render();
  }
}

function viewDrill() {
  if (!S.bundle || S.bundle.drill.drillId !== S.drillId) return h('section', { class: 'panel' }, 'Loading drill…');
  var b = S.bundle, d = b.drill, typeDef = getDrillType(d.drillType);
  var active = activeScenarios(b.scenarios);
  var idx = STEPS.indexOf(d.status);
  var tabs = [['scenarios', 'Scenarios (' + active.length + ')'], ['key', 'Answer key'], ['form', 'Google Form'], ['responses', 'Responses' + (d.responseStats ? ' (' + d.responseStats.responses + ')' : '')], ['activity', 'Activity']];
  var body = { scenarios: tabScenarios, key: tabAnswerKey, form: tabForm, responses: tabResponses, activity: tabActivity }[S.tab](b, typeDef);
  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('div', { class: 'row spread' },
        h('div', { class: 'stack', style: 'gap:4px' },
          h('span', { class: 'mono muted' }, d.drillId),
          h('h2', null, d.title),
          h('span', { class: 'muted small' }, typeDef.name + ' · ' + d.config.scenarioCount + ' scenarios · ' + d.config.targetMinutes + ' min · ' + d.config.difficulty.toLowerCase() + ' · created ' + fmtDate(d.createdAt) + ' by ' + who(d.createdBy))),
        statusPill(d.status)),
      h('div', { class: 'stepper', 'aria-label': 'Drill lifecycle' }, STEPS.map(function (s, i) {
        return h('span', { class: i < idx ? 'done' : i === idx ? 'now' : '' }, STEP_LABEL[s]);
      })),
      drillActions(b, typeDef, active)
    ),
    h('nav', { class: 'subtabs row', 'aria-label': 'Drill sections' }, tabs.map(function (t) {
      return h('button', { type: 'button', 'aria-current': S.tab === t[0] ? 'page' : null, onclick: function () { S.tab = t[0]; render(); } }, t[1]);
    })),
    body
  );
}

function drillActions(b, typeDef, active) {
  var d = b.drill, id = d.drillId;
  var reload = async function () { await loadBundle(); };
  var acts = [];
  if (isTraineeContentEditable(d.status) && d.status !== 'APPROVED') {
    var missing = d.config.scenarioCount - active.length;
    if (missing > 0) acts.push(btn('Generate ' + missing + ' scenario' + (missing > 1 ? 's' : ''), function () { generateAll(id); }, { primary: true, disabled: !S.caps.sample, title: S.caps.sample ? null : 'Claude is not available on this view' }));
    else acts.push(btn('Generate one more', function () { act('Generating a scenario', async function () { await svc.generateNextScenario(id); await reload(); }); }, { disabled: !S.caps.sample }));
    acts.push(btn('Write one manually', function () { act('Adding a blank scenario', async function () { var s = await svc.addManualScenario(id); S.editing[s.scenarioId] = true; await reload(); }); }));
    acts.push(btn('Approve drill', function () { act('Approving', async function () { await svc.approveDrill(id); await reload(); }, 'Approved. Only this version will go into the Google Form.'); }, { primary: missing <= 0 }));
  }
  if (d.status === 'APPROVED') {
    acts.push(btn('Create Google Form', function () { act('Requesting the Google Form', async function () { var r = await svc.createForm(id); await reload(); return r; }, function (r) { return r && r.reused ? 'Existing form request found. No duplicate was created.' : 'Form requested. The bridge builds it within about 5 minutes.'; }); }, { primary: true }));
    acts.push(btn('Reopen for edits', function () { act('Reopening', async function () { await svc.reopenForEdits(id); await reload(); }); }));
  }
  if (d.status === 'FORM_CREATING') {
    acts.push(btn('Check form status', function () { act('Checking the bridge', async function () { await svc.refreshFormStatus(id); await reload(); }, function () { return S.bundle.drill.status === 'FORM_CREATED' ? 'Google Form is ready.' : 'Not built yet. The bridge runs every 5 minutes.'; }); }, { primary: true }));
    acts.push(btn('Resend request', function () { act('Resending the request', async function () { var r = await svc.createForm(id); await reload(); return r; }, function (r) { return r && r.reused ? 'The request is already in the bridge folder. Nothing duplicated.' : 'Request written.'; }); }));
  }
  if (d.status === 'FORM_CREATED') acts.push(btn('Mark as sent to trainees', function () { act('Marking as sent', async function () { await svc.markSent(id, ''); await reload(); }); }, { primary: true }));
  if (['FORM_CREATED', 'SENT', 'RESPONSES_RECEIVED', 'UNDER_REVIEW'].indexOf(d.status) !== -1) {
    acts.push(btn('Sync responses', function () { act('Reading responses from the bridge', async function () { var r = await svc.syncResponses(id); await reload(); S.tab = 'responses'; return r; }, function (r) { return !r ? '' : r.status === 'NO_EXPORT_YET' ? 'No response export yet. The bridge writes one every 5 minutes.' : r.created + ' new, ' + r.updated + ' updated' + (r.unmapped.length ? ', ' + r.unmapped.length + ' answers could not be mapped' : ''); }); }, { primary: d.status === 'SENT' }));
  }
  if (['RESPONSES_RECEIVED', 'UNDER_REVIEW'].indexOf(d.status) !== -1) {
    acts.push(btn('Accept remaining auto scores', function () { act('Accepting auto scores', async function () { var r = await svc.acceptAutoScores(id); await reload(); return r; }, function (r) { return r ? r.accepted + ' auto scores accepted' : ''; }); }));
    acts.push(btn('Complete drill', function () { act('Completing', async function () { await svc.completeDrill(id, false); await reload(); }, 'Drill completed.'); }));
  }
  if (d.status === 'COMPLETED') acts.push(btn('Reopen review', function () { act('Reopening review', async function () { await svc.reopenReview(id); await reload(); }); }));
  return h('div', { class: 'row' }, acts);
}

function flagView(b, s, f) {
  var noteId = 'flag-' + s.scenarioId + '-' + f.code;
  return h('div', { class: 'flag' + (f.resolved ? ' resolved' : f.blocking ? ' blocking' : '') },
    h('div', { class: 'row' }, pill(f.code.replace(/_/g, ' ').toLowerCase(), f.resolved ? '' : f.blocking ? 'bad' : 'warn'), h('span', { class: 'small' }, f.message)),
    f.resolved ? h('span', { class: 'small' }, 'Resolved by ' + who(f.resolvedBy) + ': ' + f.resolvedNote) : null,
    !f.resolved && f.resolvable && isTraineeContentEditable(b.drill.status) ? h('div', { class: 'row' },
      h('input', { id: noteId, placeholder: 'How did you confirm this? (required)', style: 'flex:1;min-width:200px' }),
      btn('Resolve', function () { act('Resolving flag', async function () { await svc.resolveFlag(b.drill.drillId, s.scenarioId, f.code, val(noteId)); await loadBundle(); }); })) : null);
}

function traineeView(s) {
  var t = s.trainee;
  return h('div', { class: 'stack' },
    t.title ? h('h3', null, t.title) : null,
    h('p', { class: 'ticket' }, t.scenario || h('span', { class: 'muted' }, 'No ticket text yet.')),
    t.accountDetails && t.accountDetails.length ? h('dl', { class: 'facts' }, t.accountDetails.map(function (a) { return [h('dt', null, a.label), h('dd', null, a.value)]; })) : null,
    t.traineeInstructions ? h('p', { class: 'small' }, t.traineeInstructions) : null,
    h('div', { class: 'stack', style: 'gap:6px' }, t.questions.map(function (q, i) {
      return h('div', { class: 'q' }, h('span', null, h('span', { class: 'mono muted' }, 'Q' + (i + 1) + ' '), q.prompt, q.required ? '' : h('span', { class: 'muted' }, ' (optional)')),
        q.choices && q.choices.length ? h('ul', { class: 'small' }, q.choices.map(function (c) { return h('li', null, c); })) : null);
    })));
}

function tabScenarios(b, typeDef) {
  var list = activeScenarios(b.scenarios);
  if (!list.length) {
    return h('section', { class: 'panel empty' }, h('h2', null, 'No scenarios yet'), h('p', null, 'Generate them from the approved sources, or write one manually. Nothing is final until you approve the drill.'));
  }
  var editable = isTraineeContentEditable(b.drill.status);
  return h('div', { class: 'stack' }, list.map(function (s) {
    var open = S.editing[s.scenarioId];
    var hintId = 'hint-' + s.scenarioId;
    return h('section', { class: 'panel' },
      h('div', { class: 'scenario-head' }, h('span', { class: 'mono' }, s.scenarioId), pill('v' + s.version), pill(s.difficulty.toLowerCase()), s.category ? pill(s.category) : null, pill(s.generatedBy === 'MANUAL' ? 'written by trainer' : 'generated')),
      (s.reviewFlags || []).length ? h('div', { class: 'stack', style: 'gap:6px' }, s.reviewFlags.map(function (f) { return flagView(b, s, f); })) : null,
      open ? scenarioEditor(b, s, editable) : h('div', { class: 'grid2' },
        h('div', { class: 'stack' }, h('span', { class: 'label' }, 'Trainee sees'), traineeView(s)),
        h('div', { class: 'stack panel flat' }, h('span', { class: 'label' }, 'Answer key (trainers only)'),
          h('p', null, h('strong', null, s.trainer.correctDecision || '—')),
          h('p', { class: 'small' }, h('span', { class: 'muted' }, 'Deciding detail: '), s.trainer.requiredAccountDetail || '—'),
          h('p', { class: 'small' }, s.trainer.rationale || ''),
          sourceList(s.trainer.sources))),
      open ? null : h('div', { class: 'row' },
        btn(editable ? 'Edit' : 'Edit answer key', function () { S.editing[s.scenarioId] = true; render(); }),
        editable ? h('input', { id: hintId, placeholder: 'Optional hint for regeneration', style: 'flex:1;min-width:200px' }) : null,
        editable ? btn('Regenerate', function () { act('Regenerating ' + s.scenarioId, async function () { await svc.regenerateScenario(b.drill.drillId, s.scenarioId, { trainerHint: val(hintId) }); await loadBundle(); }); }, { disabled: !S.caps.sample }) : null,
        editable ? (S.confirmRemove === s.scenarioId
          ? btn('Confirm remove ' + s.scenarioId, function () { S.confirmRemove = null; act('Removing', async function () { await svc.removeScenario(b.drill.drillId, s.scenarioId); await loadBundle(); }); }, { danger: true })
          : btn('Remove', function () { S.confirmRemove = s.scenarioId; render(); }, { danger: true })) : null)
    );
  }));
}

function sourceList(sources) {
  if (!sources || !sources.length) return h('p', { class: 'small muted' }, 'No source cited.');
  return h('div', { class: 'stack', style: 'gap:6px' }, sources.map(function (src) {
    return h('div', { class: 'small' },
      h('div', { class: 'row' }, pill(src.verified ? 'verified quote' : 'not found in source', src.verified ? 'ok' : 'bad'),
        src.url ? h('a', { href: src.url, target: '_blank', rel: 'noopener' }, src.heading || src.title || 'Open source') : h('span', null, src.heading || src.title || src.sourceType || '')),
      h('q', null, src.quote));
  }));
}

function scenarioEditor(b, s, editable) {
  var sid = s.scenarioId, t = s.trainee, tr = s.trainer;
  var dis = !editable;
  var qEls = t.questions.map(function (q, i) {
    var isChoice = CHOICE_TYPES.indexOf(q.type) !== -1;
    var exp = asArray((tr.correctAnswer || {})[q.key]);
    var rule = (tr.scoring || {})[q.key] || {};
    return h('div', { class: 'panel flat' },
      h('div', { class: 'row' }, h('span', { class: 'mono' }, 'Q' + (i + 1)), pill(q.type.toLowerCase().replace('_', ' ')), pill(rule.mode === 'AUTO' ? 'auto-scored' : 'trainer-scored', rule.mode === 'AUTO' ? 'accent' : 'warn')),
      field('Question', h('input', { id: 'e-' + sid + '-q-' + q.key, value: q.prompt, disabled: dis })),
      isChoice ? field('Answer choices (one per line)', h('textarea', { id: 'e-' + sid + '-c-' + q.key, disabled: dis }, (q.choices || []).join('\n'))) : null,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'e-' + sid + '-r-' + q.key, checked: q.required, disabled: dis }), 'Required'),
      field(isChoice ? 'Correct choice(s), one per line' : 'Expected answer (guide for the trainer)', h('textarea', { id: 'e-' + sid + '-a-' + q.key }, exp.join('\n'))),
      field('Points', h('input', { id: 'e-' + sid + '-p-' + q.key, type: 'number', min: '0', value: String(rule.points != null ? rule.points : 0) })));
  });
  return h('div', { class: 'stack' },
    dis ? h('div', { class: 'notice warn' }, 'The Google Form exists, so what trainees see is locked. You can still correct the answer key; responses are rescored automatically.') : null,
    h('span', { class: 'label' }, 'Trainee-facing'),
    h('div', { class: 'fields' }, field('Title', h('input', { id: 'e-' + sid + '-title', value: t.title || '', disabled: dis }))),
    field('Customer ticket', h('textarea', { id: 'e-' + sid + '-ticket', style: 'min-height:140px', disabled: dis }, t.scenario || '')),
    field('Account details (one per line, "Label: value")', h('textarea', { id: 'e-' + sid + '-facts', style: 'min-height:110px', disabled: dis }, (t.accountDetails || []).map(function (a) { return a.label + ': ' + a.value; }).join('\n'))),
    field('Extra instructions for this ticket (optional)', h('input', { id: 'e-' + sid + '-instr', value: t.traineeInstructions || '', disabled: dis })),
    h('span', { class: 'label' }, 'Questions and answer key'),
    qEls,
    h('span', { class: 'label' }, 'Trainer-only'),
    h('div', { class: 'fields' },
      field('Correct decision (summary)', h('input', { id: 'e-' + sid + '-dec', value: tr.correctDecision || '' })),
      field('Deciding account detail', h('input', { id: 'e-' + sid + '-detail', value: tr.requiredAccountDetail || '' }))),
    field('Rationale', h('textarea', { id: 'e-' + sid + '-rat' }, tr.rationale || '')),
    field('Sources (one per line: "SECTION-ID :: exact quote", section ID optional)', h('textarea', { id: 'e-' + sid + '-src' }, (tr.sources || []).map(function (x) { return (x.sectionId ? x.sectionId + ' :: ' : '') + x.quote; }).join('\n'))),
    field('Common mistakes (one per line)', h('textarea', { id: 'e-' + sid + '-mis' }, (tr.commonMistakes || []).join('\n'))),
    field('Coaching notes', h('textarea', { id: 'e-' + sid + '-coach' }, tr.coachingNotes || '')),
    field('Trainer notes', h('textarea', { id: 'e-' + sid + '-notes' }, tr.trainerNotes || '')),
    h('div', { class: 'row' },
      btn('Save changes', function () { saveScenario(b, s, editable); }, { primary: true }),
      btn('Cancel', function () { delete S.editing[sid]; render(); }, { write: false }))
  );
}

function saveScenario(b, s, editable) {
  var sid = s.scenarioId;
  var p = function (k) { return 'e-' + sid + '-' + k; };
  var patch = { trainer: {
    correctDecision: val(p('dec')), requiredAccountDetail: val(p('detail')), rationale: val(p('rat')),
    commonMistakes: lines(val(p('mis'))), coachingNotes: val(p('coach')), trainerNotes: val(p('notes')),
    sources: lines(val(p('src'))).map(function (line) {
      var i = line.indexOf('::');
      return i === -1 ? { quote: line } : { sectionId: line.slice(0, i).trim(), quote: line.slice(i + 2).trim() };
    }),
    correctAnswer: {}, scoring: {}
  } };
  s.trainee.questions.forEach(function (q) {
    var a = lines(val(p('a-' + q.key)));
    patch.trainer.correctAnswer[q.key] = CHOICE_TYPES.indexOf(q.type) !== -1 ? a : a.join(' ');
    patch.trainer.scoring[q.key] = { points: val(p('p-' + q.key)) };
  });
  if (editable) {
    patch.trainee = {
      title: val(p('title')), scenario: val(p('ticket')), traineeInstructions: val(p('instr')),
      accountDetails: lines(val(p('facts'))).map(function (line) {
        var i = line.indexOf(':');
        return i === -1 ? { label: line, value: '' } : { label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
      }),
      questions: s.trainee.questions.map(function (q) {
        var out = { key: q.key, prompt: val(p('q-' + q.key)), required: checked(p('r-' + q.key)) };
        if (CHOICE_TYPES.indexOf(q.type) !== -1) out.choices = lines(val(p('c-' + q.key)));
        return out;
      })
    };
  }
  act('Saving ' + sid, async function () {
    await svc.updateScenario(b.drill.drillId, sid, patch);
    delete S.editing[sid];
    await loadBundle();
  }, 'Saved ' + sid);
}

function tabAnswerKey(b) {
  var list = activeScenarios(b.scenarios);
  if (!list.length) return h('section', { class: 'panel empty' }, 'No scenarios yet.');
  return h('div', { class: 'stack' }, list.map(function (s) {
    var tr = s.trainer;
    return h('section', { class: 'panel' },
      h('div', { class: 'scenario-head' }, h('span', { class: 'mono' }, s.scenarioId), h('h3', null, s.trainee.title || 'Untitled scenario')),
      h('details', null, h('summary', { class: 'small' }, 'Show the ticket'), h('div', { style: 'margin-top:8px' }, traineeView(s))),
      h('div', { class: 'grid2' },
        h('div', { class: 'stack' },
          h('div', null, h('span', { class: 'label' }, 'Correct answer'), h('p', null, h('strong', null, tr.correctDecision || '—'))),
          h('div', null, h('span', { class: 'label' }, 'Required account detail'), h('p', null, tr.requiredAccountDetail || '—')),
          h('div', null, h('span', { class: 'label' }, 'Rationale'), h('p', null, tr.rationale || '—')),
          h('div', null, h('span', { class: 'label' }, 'Coaching notes'), h('p', null, tr.coachingNotes || '—'))),
        h('div', { class: 'stack' },
          h('div', null, h('span', { class: 'label' }, 'Source'), sourceList(tr.sources)),
          h('div', null, h('span', { class: 'label' }, 'Scoring criteria'), h('ul', { class: 'small' }, (tr.scoringCriteria || []).map(function (c) { return h('li', null, c); }))),
          h('div', null, h('span', { class: 'label' }, 'Common mistakes'), h('ul', { class: 'small' }, (tr.commonMistakes || []).map(function (c) { return h('li', null, c); }))))));
  }));
}

function tabForm(b, typeDef) {
  var d = b.drill;
  var head;
  if (d.form && d.form.state === 'CREATED') {
    head = h('section', { class: 'panel' },
      h('h2', null, 'Google Form ready'),
      h('div', { class: 'stack' },
        h('div', null, h('span', { class: 'label' }, 'Link for trainees'),
          h('div', { class: 'row' }, h('input', { id: 'form-link', value: d.form.publishedUrl, readonly: true, style: 'flex:1;min-width:220px', onfocus: function (e) { e.target.select(); } }),
            btn('Copy link', function () { copyText(d.form.publishedUrl); }, { write: false }))),
        h('div', { class: 'row small' },
          h('a', { href: d.form.editUrl, target: '_blank', rel: 'noopener' }, 'Open form editor'),
          d.form.responseSheetUrl ? h('a', { href: d.form.responseSheetUrl, target: '_blank', rel: 'noopener' }, 'Open response sheet') : null,
          h('span', { class: 'muted mono' }, 'Form ID ' + d.form.formId)),
        h('p', { class: 'small muted' }, 'Share only the trainee link. Trainees sign in with their Google account; the form collects their verified email so each submission maps to a person.')));
  } else if (d.status === 'FORM_CREATING') {
    head = h('section', { class: 'panel' }, h('h2', null, 'Waiting for the Form Bridge'),
      h('p', null, 'The request for this drill is in the bridge folder. The bridge script runs every 5 minutes, builds the form, and writes the result back. Use "Check form status" above.'),
      d.form && d.form.lastError ? h('div', { class: 'notice bad' }, 'Last bridge attempt failed: ' + d.form.lastError + '. The bridge retries on its next run without creating a second form.') : null);
  } else {
    head = h('section', { class: 'panel' }, h('h2', null, 'No form yet'), h('p', { class: 'muted' }, d.status === 'APPROVED' ? 'Use "Create Google Form" above.' : 'Approve the drill first. Below is a preview of what trainees would see right now.'));
  }
  var preview;
  try {
    var ids = d.approval ? d.approval.scenarioIds : null;
    var scen = activeScenarios(b.scenarios).filter(function (s) { return !ids || ids.indexOf(s.scenarioId) !== -1; });
    var spec = buildFormSpec(d, scen, typeDef, { collectVerifiedEmail: !S.settings || S.settings.collectVerifiedEmail !== false });
    preview = h('section', { class: 'stack' }, h('span', { class: 'label' }, 'What trainees see in the form'),
      h('div', { class: 'formprev' },
        h('div', { class: 'card section-card' }, h('h2', null, spec.title), h('pre', { class: 'help' }, spec.description)),
        spec.items.map(function (it) {
          if (it.kind === 'SECTION') return h('div', { class: 'card section-card' }, h('h3', null, it.title), h('pre', { class: 'help' }, it.helpText));
          return h('div', { class: 'card' }, h('span', null, it.title, it.required ? h('span', { style: 'color:var(--bad)' }, ' *') : null),
            it.choices && it.choices.length ? h('ul', { class: 'small' }, it.choices.map(function (c) { return h('li', null, (it.type === 'CHECKBOX' ? '☐ ' : '○ ') + c); })) : h('span', { class: 'muted small' }, it.type === 'PARAGRAPH' ? 'Long answer' : 'Short answer'));
        })));
  } catch (e) {
    preview = h('div', { class: 'notice bad' }, errorText(e));
  }
  return h('div', { class: 'stack' }, head, preview);
}

function tabResponses(b) {
  var d = b.drill;
  if (!d.form || d.form.state !== 'CREATED') return h('section', { class: 'panel empty' }, 'Responses appear here after the Google Form is created and trainees submit it.');
  var stats = d.responseStats;
  var byScenario = {};
  b.scenarios.forEach(function (s) { byScenario[s.scenarioId] = s; });
  var trainees = uniq(b.responses.map(function (r) { return r.traineeId; }));
  var shown = b.responses.filter(function (r) { return !S.respTrainee || r.traineeId === S.respTrainee; });
  var reviewOpen = ['RESPONSES_RECEIVED', 'UNDER_REVIEW'].indexOf(d.status) !== -1;
  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('div', { class: 'row spread' }, h('h2', null, 'Responses'),
        stats ? h('span', { class: 'muted small' }, stats.responses + ' submissions from ' + stats.trainees + ' trainees · ' + stats.pendingReview + ' answers to score · synced ' + fmtDate(stats.lastSyncAt)) : h('span', { class: 'muted small' }, 'Not synced yet')),
      stats && stats.unmapped ? h('div', { class: 'notice warn' }, stats.unmapped + ' answers could not be matched to a scenario question (for example a question added in the Forms editor). They were not imported.') : null,
      trainees.length > 1 ? field('Trainee', h('select', { id: 'resp-trainee', onchange: function () { S.respTrainee = val('resp-trainee'); render(); } },
        h('option', { value: '' }, 'All trainees'), trainees.map(function (t) {
          var r = b.responses.filter(function (x) { return x.traineeId === t; })[0];
          return h('option', { value: t, selected: S.respTrainee === t }, r.traineeName || r.traineeEmail || t);
        }))) : null,
      !b.responses.length ? h('p', { class: 'muted' }, 'No submissions yet. Use "Sync responses" after trainees submit.') : null),
    shown.map(function (r) {
      var keys = Object.keys(r.answers).sort();
      return h('section', { class: 'panel' },
        h('div', { class: 'row spread' }, h('div', null, h('h3', null, r.traineeName || r.traineeEmail || 'Unknown trainee'), h('span', { class: 'small muted' }, (r.traineeEmail || 'no verified email') + ' · submitted ' + fmtDate(r.submittedAt))),
          r.summary ? pill(r.summary.earned + ' / ' + r.summary.possible + (r.summary.pct != null ? ' (' + r.summary.pct + '%)' : '') + (r.summary.pendingReview ? ' · ' + r.summary.pendingReview + ' to score' : ''), r.summary.pendingReview ? 'warn' : 'ok') : null),
        keys.map(function (k) { return answerRow(b, r, k, byScenario[r.answers[k].scenarioId], reviewOpen); }));
    }));
}

function answerRow(b, r, key, scenario, reviewOpen) {
  var a = r.answers[key], sc = a.score;
  if (!scenario || !sc) return h('div', { class: 'notice warn' }, key + ': scenario not found.');
  var q = scenario.trainee.questions.filter(function (x) { return x.key === a.questionKey; })[0] || { prompt: a.questionKey };
  var expected = scenario.trainer.correctAnswer[a.questionKey];
  var eff = effectiveScore(sc);
  var state = eff == null ? 'pending' : eff >= sc.maxPoints ? 'right' : 'wrong';
  var base = 'sc-' + r.responseKey.replace(/[^A-Za-z0-9]/g, '') + '-' + key.replace(/[^A-Za-z0-9]/g, '');
  return h('div', { class: 'stack', style: 'gap:8px;border-top:1px solid var(--line);padding-top:10px' },
    h('div', { class: 'row' }, h('span', { class: 'mono' }, a.scenarioId), h('span', null, q.prompt),
      pill(sc.mode === 'AUTO' ? 'auto ' + sc.autoScore + '/' + sc.maxPoints : 'trainer-scored', sc.mode === 'AUTO' ? (sc.autoCorrect ? 'ok' : 'bad') : ''),
      sc.finalScore != null ? pill('final ' + sc.finalScore + '/' + sc.maxPoints, 'accent') : null,
      sc.reviewStatus === 'NEEDS_REVIEW' ? pill(sc.staleSinceReview ? 'answer key changed, recheck' : 'needs score', 'warn') : null),
    h('div', { class: 'compare' },
      h('div', { class: state }, h('span', { class: 'label' }, 'Trainee answer'), h('p', null, answerText(a.answer)),
        sc.assist && sc.assist.matchedTerms && sc.assist.matchedTerms.length ? h('p', { class: 'small muted' }, 'Overlaps the expected detail on: ' + sc.assist.matchedTerms.join(', ')) : null),
      h('div', null, h('span', { class: 'label' }, 'Expected answer'), h('p', null, answerText(expected)),
        h('details', { class: 'small' }, h('summary', null, 'Rationale and source'),
          h('p', null, scenario.trainer.rationale || '—'), sourceList(scenario.trainer.sources)))),
    reviewOpen && sc.maxPoints > 0 ? h('div', { class: 'stack', style: 'gap:6px' },
      h('div', { class: 'row' },
        h('label', { class: 'field', style: 'width:120px' }, h('span', { class: 'label' }, 'Final score'), h('input', { id: base + '-s', type: 'number', min: '0', max: String(sc.maxPoints), step: '0.5', value: sc.finalScore != null ? String(sc.finalScore) : '' })),
        h('div', { class: 'row', style: 'flex:1' }, GAP_TAGS.map(function (g) {
          return h('label', { class: 'check small' }, h('input', { type: 'checkbox', id: base + '-g-' + g, checked: (sc.gapTags || []).indexOf(g) !== -1 }), GAP_LABEL[g]);
        }))),
      h('textarea', { id: base + '-n', placeholder: 'Coaching note for this answer' }, sc.coachingNote || ''),
      h('div', { class: 'row' }, btn('Save score', function () {
        var s = val(base + '-s');
        act('Saving score', async function () {
          await svc.scoreAnswer(b.drill.drillId, r.responseKey, key, {
            finalScore: s === '' ? null : Number(s),
            gapTags: GAP_TAGS.filter(function (g) { return checked(base + '-g-' + g); }),
            coachingNote: val(base + '-n')
          });
          await loadBundle();
        }, 'Score saved');
      }))) : (sc.coachingNote ? h('p', { class: 'small' }, h('span', { class: 'muted' }, 'Coaching note: '), sc.coachingNote) : null));
}

function tabActivity(b) {
  var items = (b.drill.audit || []).slice().reverse();
  return h('section', { class: 'panel' }, h('h2', null, 'Activity'),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'))),
      h('tbody', null, items.map(function (a) {
        return h('tr', null, h('td', null, fmtDate(a.at)), h('td', null, who(a.by)), h('td', null, a.action.replace(/_/g, ' ').toLowerCase(), a.details && a.details.scenarioId ? ' ' + a.details.scenarioId : ''));
      })))));
}

// ---------------------------------------------------------------- Coaching

function viewCoaching() {
  var r = S.report;
  var filter = h('select', { id: 'rep-type', onchange: function () { S.reportType = val('rep-type'); go('coaching'); } },
    h('option', { value: '' }, 'All drill types'), listDrillTypeSummaries().map(function (t) { return h('option', { value: t.type, selected: S.reportType === t.type }, t.name); }));
  if (!r) return h('section', { class: 'panel' }, field('Drill type', filter), h('p', { class: 'muted' }, 'Loading…'));
  if (!r.trainees.length) return h('section', { class: 'panel empty' }, field('Drill type', filter), h('h2', null, 'No scored answers yet'), h('p', null, 'Coaching insights appear once responses are synced and scored.'));
  var maxGap = Math.max.apply(null, r.gaps.map(function (g) { return g.count; }).concat([1]));
  return h('div', { class: 'stack' },
    h('section', { class: 'panel' }, h('div', { class: 'row spread' }, h('h2', null, 'Coaching'), h('div', { style: 'min-width:200px' }, filter))),
    h('div', { class: 'grid2' },
      h('section', { class: 'panel' }, h('h3', null, 'Knowledge gaps across the cohort'),
        r.gaps.length ? r.gaps.map(function (g) {
          return h('div', { class: 'stack', style: 'gap:2px' }, h('div', { class: 'row spread small' }, h('span', null, GAP_LABEL[g.tag] || g.tag), h('span', { class: 'mono' }, String(g.count))),
            h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.round(g.count / maxGap * 100) + '%' })));
        }) : h('p', { class: 'muted' }, 'No gaps tagged yet.')),
      h('section', { class: 'panel' }, h('h3', null, 'Most common wrong answers'),
        r.commonWrongAnswers.length ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Expected'), h('th', null, 'Chosen'), h('th', null, 'Times'))),
          h('tbody', null, r.commonWrongAnswers.slice(0, 12).map(function (w) { return h('tr', null, h('td', null, w.expected), h('td', null, w.given), h('td', { class: 'mono' }, String(w.count))); })))) : h('p', { class: 'muted' }, 'None yet.'))),
    h('section', { class: 'panel' }, h('h3', null, 'Trainees (lowest score first)'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Trainee', 'Drills', 'Score', 'To score', 'Top gaps'].map(function (c) { return h('th', null, c); }))),
        h('tbody', null, r.trainees.map(function (t) {
          return h('tr', null, h('td', null, t.name || t.email || t.traineeId), h('td', { class: 'mono' }, String(t.drills)),
            h('td', { class: 'mono' }, t.pct == null ? '—' : t.pct + '%'), h('td', { class: 'mono' }, String(t.pendingReview)),
            h('td', null, t.topGaps.slice(0, 3).map(function (g) { return pill((GAP_LABEL[g.tag] || g.tag) + ' ×' + g.count, 'warn'); })));
        }))))),
    h('div', { class: 'grid2' },
      h('section', { class: 'panel' }, h('h3', null, 'Accuracy by question'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Drill'), h('th', null, 'Question'), h('th', null, 'Correct'), h('th', null, 'Pending'))),
          h('tbody', null, r.questions.map(function (q) {
            return h('tr', null, h('td', null, getDrillType(q.drillType).name), h('td', null, q.questionKey), h('td', { class: 'mono' }, q.accuracyPct == null ? '—' : q.accuracyPct + '%'), h('td', { class: 'mono' }, String(q.pending)));
          }))))),
      h('section', { class: 'panel' }, h('h3', null, 'Drill results over time'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Drill'), h('th', null, 'Answers'), h('th', null, 'Score'))),
          h('tbody', null, r.trend.slice().reverse().map(function (t) {
            return h('tr', { class: 'click', onclick: function () { openDrill(t.drillId, 'responses'); } }, h('td', { class: 'mono' }, t.drillId), h('td', { class: 'mono' }, String(t.answers)), h('td', { class: 'mono' }, t.pct == null ? '—' : t.pct + '%'));
          })))))));
}

// ---------------------------------------------------------------- Sources

function viewSources() {
  var meta = S.settings && S.settings.sourcesMeta;
  var sections = S.sections || [];
  var f = normalizeText(S.sourceFilter);
  var matches = f ? sections.filter(function (s) { return normalizeText(s.path + ' ' + s.text).indexOf(f) !== -1; }) : sections;
  var channels = (S.settings && S.settings.csqChannels) || [];
  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('h2', null, 'Care Knowledge Library'),
      h('p', { class: 'muted' }, 'Scenarios and answer keys are generated only from these sections and approved CSQ snippets. Every cited quote is checked against them.'),
      meta ? h('p', { class: 'small' }, meta.sections + ' sections from the export of ' + fmtDate(meta.generatedAt) + ', imported ' + fmtDate(meta.importedAt) + ' by ' + who(meta.importedBy) + '.') : h('div', { class: 'notice warn' }, 'Not imported yet.'),
      h('div', { class: 'row' },
        btn('Ask the bridge for a fresh export', function () { act('Writing the export request', function () { return svc.requestSourceRefresh(); }, 'Requested. The bridge exports within about 5 minutes; then import it.'); }),
        btn('Import latest export', function () { act('Importing source sections', async function () { var r = await svc.importSources(); await loadSettings(); S.sections = await svc.getAllSections(); return r; }, function (r) {
          if (!r) return '';
          if (r.status === 'OK') return r.sections + ' sections imported';
          S.error = noExportReason(r.bridge);
          return '';
        }); }, { primary: true })),
      sections.length ? h('div', { class: 'stack' },
        h('input', { id: 'src-filter', placeholder: 'Search sections (e.g. ETF, free month, lock-out)', value: S.sourceFilter, onchange: function () { S.sourceFilter = val('src-filter'); render(); } }),
        h('p', { class: 'small muted' }, matches.length + ' of ' + sections.length + ' sections' + (matches.length > 40 ? ', showing 40' : '')),
        matches.slice(0, 40).map(function (s) {
          return h('details', { class: 'panel flat' }, h('summary', null, pill(s.sourceType === 'CSQ_SLACK' ? 'CSQ Slack' : 'Library'), ' ', s.path || s.heading, ' ', h('span', { class: 'mono muted' }, s.sectionId)),
            h('p', { class: 'small', style: 'white-space:pre-wrap;margin-top:6px' }, s.text.slice(0, 3000)), s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener', class: 'small' }, 'Open in Google Docs') : null);
        })) : null),
    h('section', { class: 'panel' },
      h('h2', null, 'CSQ Slack snippets'),
      h('p', { class: 'muted' }, 'Load recent messages from a CSQ channel and approve the ones that state current guidance. Only approved snippets are used as sources.'),
      h('div', { class: 'row' },
        h('select', { id: 'csq-ch', style: 'max-width:280px', onchange: function () { S.csq.channelId = val('csq-ch'); var c = channels.filter(function (x) { return x.id === S.csq.channelId; })[0]; S.csq.channelName = c ? c.name : ''; } },
          h('option', { value: '' }, channels.length ? 'Choose a channel' : 'Add CSQ channels in Settings'),
          channels.map(function (c) { return h('option', { value: c.id, selected: S.csq.channelId === c.id }, '#' + c.name); })),
        btn('Load recent messages', function () {
          if (!S.csq.channelId) { S.error = 'Choose a channel first.'; render(); return; }
          act('Reading #' + (S.csq.channelName || S.csq.channelId), async function () { S.csq.messages = await svc.fetchCsqMessages(S.csq.channelId); });
        }, { disabled: !S.caps.mcp, write: false })),
      S.csq.messages.length ? h('div', { class: 'stack' }, S.csq.messages.map(function (m) {
        return h('div', { class: 'panel flat' }, h('div', { class: 'row small muted' }, h('span', null, m.author || 'Unknown'), h('span', null, m.postedAt)),
          h('p', { style: 'white-space:pre-wrap' }, m.text),
          h('div', { class: 'row' }, btn('Approve as source', function () {
            act('Approving snippet', async function () { await svc.approveSnippet(Object.assign({ channelName: S.csq.channelName }, m)); S.snippets = await svc.listSnippets(); S.sections = await svc.getAllSections(); }, 'Snippet approved');
          })));
      })) : null,
      h('h3', null, 'Approved snippets'),
      S.snippets.filter(function (x) { return x.status === 'APPROVED'; }).length ? S.snippets.filter(function (x) { return x.status === 'APPROVED'; }).map(function (sn) {
        return h('div', { class: 'row spread panel flat' }, h('div', { style: 'min-width:0;flex:1' }, h('span', { class: 'small muted' }, '#' + (sn.channelName || sn.channelId) + ' · ' + (sn.author || '') + ' · ' + sn.postedAt), h('p', { class: 'small', style: 'white-space:pre-wrap' }, sn.text)),
          btn('Withdraw', function () { act('Withdrawing snippet', async function () { await svc.setSnippetStatus(sn.snippetId, 'REJECTED'); S.snippets = await svc.listSnippets(); S.sections = await svc.getAllSections(); }); }, { danger: true }));
      }) : h('p', { class: 'muted small' }, 'None approved yet.')),
    viewCatalog());
}

// Explains a missing source export from the bridge's own status file.
function noExportReason(status) {
  if (!status) {
    return 'No export yet, and the Form Bridge has never reported a run. Update the bridge to the latest Code.js and appsscript.json, run runBridge once from the Apps Script editor (accept the new permissions), and check that a runBridge trigger exists under Triggers.';
  }
  var ran = fmtDate(status.finishedAt || status.startedAt);
  if (status.steps && /^error/.test(status.steps.sources || '')) {
    return 'The Form Bridge failed to export the Knowledge Library on its last run (' + ran + '): ' + status.steps.sources.replace(/^error: /, '');
  }
  return 'No export yet. The Form Bridge last ran ' + ran + '. If you just asked for an export, wait for its next run (every 5 minutes) and import again.';
}

function viewCatalog() {
  var entries = S.catalog.slice().sort(function (a, b) { return a.status === b.status ? (a.name < b.name ? -1 : 1) : (a.status === 'APPROVED' ? -1 : 1); });
  return h('section', { class: 'panel' },
    h('h2', null, 'Triage process catalog'),
    h('p', { class: 'muted' }, 'The answer choices for Triage-Only drills (process, tag, checklist) come only from approved entries here. Propose entries from the sources, check each against the Library, then approve.'),
    h('div', { class: 'row' }, btn('Propose entries from sources', function () { act('Reading sources for documented processes', async function () { await svc.proposeCatalog(); S.catalog = await svc.listCatalog(); }); }, { disabled: !S.caps.sample })),
    entries.length ? entries.map(function (e) {
      var id = 'cat-' + e.catalogId;
      return h('div', { class: 'panel flat' },
        h('div', { class: 'row' }, h('span', { class: 'mono' }, e.catalogId), pill(e.status.toLowerCase(), e.status === 'APPROVED' ? 'ok' : e.status === 'REJECTED' ? 'bad' : 'warn')),
        h('div', { class: 'fields' },
          field('Process', h('input', { id: id + '-name', value: e.name })),
          field('Tag', h('input', { id: id + '-tag', value: e.tag || '', placeholder: 'Not documented' })),
          field('Checklist / process to launch', h('input', { id: id + '-check', value: e.checklist || '', placeholder: 'Not documented' })),
          field('Category', h('select', { id: id + '-cat' }, TRIAGE_CATEGORIES.map(function (c) { return h('option', { value: c, selected: e.category === c }, c); })))),
        field('When to use', h('input', { id: id + '-when', value: e.whenToUse || '' })),
        sourceList(e.sources),
        h('div', { class: 'row' },
          h('input', { id: id + '-note', placeholder: 'Approval note (required when no quote was verified)', style: 'flex:1;min-width:220px' }),
          btn('Save', function () { saveCatalog(e, null); }),
          e.status !== 'APPROVED' ? btn('Approve', function () { saveCatalog(e, 'APPROVED'); }, { primary: true }) : null,
          e.status !== 'REJECTED' ? btn('Reject', function () { saveCatalog(e, 'REJECTED'); }, { danger: true }) : null));
    }) : h('p', { class: 'muted small' }, 'No entries yet.'));
}

function saveCatalog(e, status) {
  var id = 'cat-' + e.catalogId;
  act('Saving catalog entry', async function () {
    await svc.updateCatalogEntry(e.catalogId, { name: val(id + '-name'), tag: val(id + '-tag'), checklist: val(id + '-check'), category: val(id + '-cat'), whenToUse: val(id + '-when'), status: status || undefined, note: val(id + '-note') });
    S.catalog = await svc.listCatalog();
  }, status ? 'Entry ' + status.toLowerCase() : 'Saved');
}

// ---------------------------------------------------------------- Settings

function viewSettings() {
  var s = S.settings || {};
  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('h2', null, 'Settings'),
      h('div', { class: 'fields' },
        field('Form Bridge Drive folder ID', h('input', { id: 'set-folder', value: s.bridgeFolderId || '', placeholder: 'Logged by setupBridge()' })),
        field('Knowledge Library Google Doc ID', h('input', { id: 'set-doc', value: s.sourceDocId || '' }))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'set-email', checked: s.collectVerifiedEmail !== false }), 'Require Google sign-in and collect verified trainee emails (recommended)'),
      field('CSQ Slack channels (one per line: "C0123ABC channel-name")', h('textarea', { id: 'set-csq' }, (s.csqChannels || []).map(function (c) { return c.id + ' ' + c.name; }).join('\n'))),
      h('div', { class: 'row' }, btn('Save settings', function () {
        act('Saving settings', async function () {
          S.settings = await svc.saveSettings({
            bridgeFolderId: val('set-folder'), sourceDocId: val('set-doc'), collectVerifiedEmail: checked('set-email'),
            csqChannels: lines(val('set-csq')).map(function (l) { var p = l.split(/\s+/); return { id: p[0], name: (p[1] || p[0]).replace(/^#/, '') }; })
          });
        }, 'Settings saved');
      }, { primary: true }))),
    h('section', { class: 'panel' },
      h('h2', null, 'Form Bridge setup'),
      h('p', null, 'Google Forms are built by a small Apps Script that runs in a trainer’s Google account. This page and the script exchange files in one private Drive folder.'),
      h('ol', null,
        h('li', null, 'Open script.google.com and create a project named "Training Drill Form Bridge".'),
        h('li', null, 'Paste the contents of src/bridge/Code.js and src/bridge/appsscript.json from the Generator repository.'),
        h('li', null, 'Run setupBridge once and accept the permissions. It creates the folder and a 5-minute trigger, then logs the folder ID.'),
        h('li', null, 'Paste that folder ID above. Share the folder with trainers only (Editor). Never share it with trainees.'),
        h('li', null, 'On Sources, ask for a fresh export, wait a few minutes, then import.'))),
    h('section', { class: 'panel' },
      h('h2', null, 'This view'),
      h('ul', { class: 'small' },
        h('li', null, 'Database: ' + (S.caps.db ? 'connected' : 'unavailable')),
        h('li', null, 'Claude for generation: ' + (S.caps.sample ? 'available' : 'unavailable')),
        h('li', null, 'Connectors (Google Drive, Slack): ' + (S.caps.mcp ? 'available' : 'unavailable')),
        h('li', null, 'Write access: ' + (S.canWrite === false ? 'view only' : 'yes')))));
}

// ---------------------------------------------------------------- boot

async function boot() {
  if (!window.claude || typeof window.claude.use !== 'function') {
    S.fatal = 'Open this dashboard from claude.ai while signed in. It keeps drills in its claude.ai database, which is not available in a saved copy of the page.';
    render();
    return;
  }
  var res = await Promise.all(['db', 'user', 'sample', 'mcp'].map(function (n) { return window.claude.use(n).catch(function () { return null; }); }));
  var db = res[0], user = res[1], sample = res[2], mcp = res[3];
  if (!db) {
    S.fatal = 'The dashboard database is not available on this view. Sign in to claude.ai and open the dashboard link you were given.';
    render();
    return;
  }
  userCap = user;
  S.caps = { db: true, user: !!user, sample: !!sample, mcp: !!mcp };
  if (user) {
    try { S.actor = (await user.id()) || 'unknown'; } catch (e) { S.actor = 'unknown'; }
    try { S.canWrite = await user.can('data.write'); } catch (e) { S.canWrite = null; }
  }
  var noBridge = { requestForm: noMcp, getFormResult: noMcp, getResponses: noMcp, requestSourceExport: noMcp, getSourceExport: noMcp };
  svc = createDrillService({
    store: makeDbStore(db),
    bridge: mcp ? makeDriveBridge(mcp) : noBridge,
    llm: sample ? makeSampleLlm(sample) : { generateJson: function () { return Promise.reject(ServiceError('NO_CLAUDE', 'Claude is not available on this view.')); } },
    slack: mcp ? makeSlackReader(mcp) : null,
    clock: { nowIso: function () { return new Date().toISOString(); }, today: today },
    actor: S.actor
  });
  S.ready = true;
  try {
    await loadSettings();
    await loadDrills();
  } catch (e) {
    S.error = errorText(e);
  }
  render();
}

function noMcp() { return Promise.reject(ServiceError('NO_CONNECTORS', 'Connectors are not available on this view, so Google Drive cannot be reached.')); }

boot();
