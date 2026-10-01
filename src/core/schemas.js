// Canonical data shapes, the trainee/trainer split, and validation.
//
// Scenario record (stored in the Scenarios table):
// {
//   scenarioUid, scenarioId, drillId, drillType, version, status: 'ACTIVE'|'REMOVED',
//   difficulty, category, generatedBy: 'CLAUDE'|'MANUAL', createdAt, updatedAt,
//   reviewFlags: [{ code, message, blocking, resolvable, resolved, resolvedBy, resolvedNote }],
//   trainee: {                       <- the ONLY part that may reach the Google Form
//     title, scenario, accountDetails: [{label, value}], traineeInstructions,
//     questions: [{ key, prompt, type, choices, required, helpText }]
//   },
//   trainer: {                       <- never leaves the dashboard
//     correctAnswer: { [questionKey]: string | string[] },
//     correctDecision, requiredAccountDetail, rationale,
//     sources: [{ sourceType, sectionId, title, heading, quote, url, verified }],
//     scoring: { [questionKey]: { mode: 'AUTO'|'MANUAL', points, method, criteria, gapTagOnWrong } },
//     scoringCriteria, commonMistakes: [string], coachingNotes, trainerNotes
//   }
// }

var QUESTION_TYPES = ['CHECKBOX', 'MULTIPLE_CHOICE', 'SHORT_TEXT', 'PARAGRAPH'];
var CHOICE_TYPES = ['CHECKBOX', 'MULTIPLE_CHOICE'];

var TRAINEE_SCENARIO_FIELDS = ['title', 'scenario', 'accountDetails', 'traineeInstructions', 'questions'];
var TRAINEE_QUESTION_FIELDS = ['key', 'prompt', 'type', 'choices', 'required', 'helpText'];

// Document collections in the dashboard database. Responses are one document per
// form submission (answers + scores embedded) to stay well under the store's
// document cap when the drill runs daily.
var COLLECTIONS = {
  drills: 'drills',          // drillId
  scenarios: 'scenarios',    // <drillId>__<scenarioId>
  responses: 'responses',    // <drillId>__<responseId>
  catalog: 'catalog',        // catalogId
  sources: 'sources',        // kl-000, kl-001 ... (chunks of source sections)
  snippets: 'snippets',      // approved CSQ Slack snippets
  settings: 'settings'       // 'main'
};

function scenarioDocId(drillId, scenarioId) {
  return drillId + '__' + scenarioId;
}

function responseDocId(drillId, responseId) {
  return drillId + '__' + String(responseId).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');
}

function toTraineeVersion(scenario) {
  var t = scenario.trainee || {};
  var out = {};
  TRAINEE_SCENARIO_FIELDS.forEach(function (f) {
    if (f === 'questions') return;
    if (t[f] !== undefined) out[f] = deepClone(t[f]);
  });
  out.scenarioId = scenario.scenarioId;
  out.questions = (t.questions || []).map(function (q) {
    var qq = {};
    TRAINEE_QUESTION_FIELDS.forEach(function (f) {
      if (q[f] !== undefined) qq[f] = deepClone(q[f]);
    });
    return qq;
  });
  return out;
}

function collectStrings(value, out) {
  out = out || [];
  if (value == null) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(function (v) { collectStrings(v, out); });
  else if (typeof value === 'object') Object.keys(value).forEach(function (k) { collectStrings(value[k], out); });
  return out;
}

// Trainer text that must never appear in trainee-facing text. The correct decision and
// the required account detail are deliberately excluded: the decision is one of the
// answer choices and the account detail is a fact the trainee must find in the ticket.
function trainerOnlyStrings(trainer) {
  trainer = trainer || {};
  var strs = [];
  collectStrings(trainer.rationale, strs);
  collectStrings(trainer.coachingNotes, strs);
  collectStrings(trainer.trainerNotes, strs);
  collectStrings(trainer.commonMistakes, strs);
  collectStrings(trainer.scoringCriteria, strs);
  (trainer.sources || []).forEach(function (s) { collectStrings(s.quote, strs); });
  return strs.map(normalizeText).filter(function (s) { return s.length >= 25; });
}

var LEAK_MARKERS = ['answer key', 'correct answer', 'rationale:', 'coaching note', 'scoring rubric', 'trainer note'];

function findTraineeLeaks(traineeVersion, trainer) {
  var traineeText = normalizeText(collectStrings(traineeVersion).join(' \n '));
  var leaks = [];
  trainerOnlyStrings(trainer).forEach(function (s) {
    if (traineeText.indexOf(s) !== -1) leaks.push('Trainer-only text appears in trainee content: "' + s.slice(0, 60) + '…"');
  });
  LEAK_MARKERS.forEach(function (m) {
    if (traineeText.indexOf(m) !== -1) leaks.push('Trainee content contains the phrase "' + m + '"');
  });
  return leaks;
}

function validateScenario(scenario) {
  var errors = [];
  var t = scenario.trainee || {};
  var tr = scenario.trainer || {};
  if (isBlank(t.scenario)) errors.push('Customer ticket text is empty.');
  if (!t.questions || !t.questions.length) errors.push('Scenario has no questions.');
  var keys = {};
  (t.questions || []).forEach(function (q, i) {
    var label = 'Question ' + (i + 1);
    if (isBlank(q.key)) errors.push(label + ' has no key.');
    if (keys[q.key]) errors.push(label + ' duplicates key ' + q.key + '.');
    keys[q.key] = true;
    if (isBlank(q.prompt)) errors.push(label + ' has no prompt.');
    if (QUESTION_TYPES.indexOf(q.type) === -1) errors.push(label + ' has unsupported type ' + q.type + '.');
    var isChoice = CHOICE_TYPES.indexOf(q.type) !== -1;
    if (isChoice && (!q.choices || q.choices.length < 2)) errors.push(label + ' needs at least two answer choices.');
    var rule = (tr.scoring || {})[q.key];
    if (!rule) {
      errors.push(label + ' has no scoring rule.');
      return;
    }
    if (rule.mode === 'AUTO') {
      if (!isChoice) errors.push(label + ' is auto-scored but is not a choice question.');
      var expected = asArray((tr.correctAnswer || {})[q.key]);
      if (!expected.length) errors.push(label + ' is auto-scored but has no correct answer.');
      expected.forEach(function (e) {
        if ((q.choices || []).indexOf(e) === -1) errors.push(label + ' correct answer "' + e + '" is not one of its choices.');
      });
      if (q.type === 'MULTIPLE_CHOICE' && expected.length > 1) errors.push(label + ' is single-choice but has several correct answers.');
    }
  });
  return errors;
}

function activeScenarios(scenarios) {
  return scenarios.filter(function (s) { return s.status !== 'REMOVED'; })
    .sort(function (a, b) { return a.scenarioId < b.scenarioId ? -1 : 1; });
}

function traineeContentHash(scenarios) {
  return hashObject(activeScenarios(scenarios).map(toTraineeVersion));
}

function blockingFlags(scenario) {
  return (scenario.reviewFlags || []).filter(function (f) { return f.blocking && !f.resolved; });
}
