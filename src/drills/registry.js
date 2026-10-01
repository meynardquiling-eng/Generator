// Drill type registry. To add a drill, write a type definition with the same shape as
// APPROVE_DENY_TYPE (ids, defaults, sourceKeywords, formInstructions, questions,
// promptGuidance, outputSchema, buildAnswerKey) and list it here.
//
// Resolved lazily (inside a function) so Apps Script file load order never matters.

function getDrillTypes() {
  return [APPROVE_DENY_TYPE, TRIAGE_TYPE];
}

function getDrillType(type) {
  var def = getDrillTypes().filter(function (d) { return d.type === type; })[0];
  if (!def) throw ServiceError('UNKNOWN_DRILL_TYPE', 'Unknown drill type: ' + type);
  return def;
}

function listDrillTypeSummaries() {
  return getDrillTypes().map(function (d) {
    return {
      type: d.type, name: d.name, description: d.description, cadence: d.cadence,
      defaults: d.defaults, requiresCatalog: !!d.requiresCatalog, categories: d.categories || null
    };
  });
}

var DIFFICULTY_GUIDANCE = {
  EASY: 'One clear deciding fact, few distractors.',
  MEDIUM: 'Two or three relevant facts, one distractor, one mildly conflicting signal.',
  HARD: 'Several account facts, prior agent actions and history, two or more distractors and a genuinely conflicting signal. The deciding fact is easy to overlook.'
};

var GAP_TAGS = [
  'INCORRECT_DECISION', 'INCORRECT_PROCESS', 'INCORRECT_TAG', 'INCORRECT_CHECKLIST',
  'MISSING_ACCOUNT_DETAIL', 'WEAK_REASONING', 'POLICY_MISREAD', 'OTHER'
];
