// Builds a provider-neutral description of the Google Form from the APPROVED scenarios.
// Only toTraineeVersion() output is read here, and the finished spec is scanned for
// trainer-only text before anything is sent to Google.

var IDENTITY_ITEM_KEY = '_trainee/name';
var IDENTITY_ITEM_TITLE = 'Your full name';

function formMarker(drillId) {
  return 'Drill ID: ' + drillId;
}

function renderTicketText(t) {
  var lines = [];
  if (!isBlank(t.title)) lines.push(t.title, '');
  lines.push('Customer ticket:', t.scenario || '');
  if (t.accountDetails && t.accountDetails.length) {
    lines.push('', 'Account details:');
    t.accountDetails.forEach(function (d) { lines.push('• ' + d.label + ': ' + d.value); });
  }
  if (!isBlank(t.traineeInstructions)) lines.push('', t.traineeInstructions);
  return lines.join('\n');
}

function buildFormSpec(drill, scenarios, typeDef, options) {
  options = options || {};
  var active = activeScenarios(scenarios);
  var items = [{
    kind: 'QUESTION', key: IDENTITY_ITEM_KEY, scenarioId: null, questionKey: null,
    title: IDENTITY_ITEM_TITLE, type: 'SHORT_TEXT', choices: [], required: true, helpText: ''
  }];
  active.forEach(function (s, si) {
    var t = toTraineeVersion(s);
    items.push({
      kind: 'SECTION', key: s.scenarioId + '/_section', scenarioId: s.scenarioId, questionKey: null,
      title: typeDef.name + ' — Scenario ' + (si + 1) + ' (' + s.scenarioId + ')',
      helpText: renderTicketText(t)
    });
    t.questions.forEach(function (q, qi) {
      items.push({
        kind: 'QUESTION', key: s.scenarioId + '/' + q.key, scenarioId: s.scenarioId, questionKey: q.key,
        title: questionTag(s.scenarioId, qi) + ' — ' + q.prompt,
        type: q.type, choices: q.choices || [], required: q.required !== false, helpText: q.helpText || ''
      });
    });
  });

  var spec = {
    drillId: drill.drillId,
    title: (drill.title || typeDef.name) + ' — ' + drill.drillId,
    description: typeDef.formInstructions(drill) + '\n\n' + formMarker(drill.drillId),
    marker: formMarker(drill.drillId),
    items: items,
    settings: {
      collectVerifiedEmail: options.collectVerifiedEmail !== false,
      limitOneResponsePerUser: options.collectVerifiedEmail !== false,
      allowResponseEdits: false,
      publishSummary: false,
      isQuiz: false,
      confirmationMessage: 'Thanks — your answers were submitted. Your trainer will review them with you.'
    }
  };
  assertFormSpecSafe(spec, active);
  spec.specHash = hashObject(spec.items);
  return spec;
}

function assertFormSpecSafe(spec, scenarios) {
  var text = normalizeText(collectStrings([spec.title, spec.description, spec.items]).join(' \n '));
  var leaks = [];
  scenarios.forEach(function (s) {
    trainerOnlyStrings(s.trainer).forEach(function (str) {
      if (text.indexOf(str) !== -1) leaks.push(s.scenarioId + ': "' + str.slice(0, 60) + '…"');
    });
  });
  if (leaks.length) {
    throw ServiceError('ANSWER_LEAK', 'Form content contains trainer-only text; fix the scenarios before creating the form. ' + leaks.join('; '));
  }
}

// Order of question keys per scenario, used to resolve "AD-001 · Q2" style tags.
function questionKeysByScenario(scenarios) {
  var map = {};
  activeScenarios(scenarios).forEach(function (s) {
    map[s.scenarioId] = (s.trainee.questions || []).map(function (q) { return q.key; });
  });
  return map;
}
