// Drill 1 — "Approve or Deny" speed drill (daily, 5 complex membership tickets, 15 minutes).

var APPROVE_DENY_ACTIONS = ['Free month', 'MF reduction', 'ETF waiver', 'None of the above'];

var APPROVE_DENY_TYPE = {
  type: 'APPROVE_DENY',
  name: 'Approve or Deny',
  description: 'Decide which membership-retention action the member qualifies for and name the account detail that proves it.',
  drillIdPrefix: 'APPROVE-DENY',
  scenarioIdPrefix: 'AD',
  cadence: 'DAILY',
  defaults: { scenarioCount: 5, targetMinutes: 15, difficulty: 'HARD' },
  requiresCatalog: false,
  sourceKeywords: [
    'free month', 'mf reduction', 'membership fee', 'etf', 'early termination', 'waiver', 'waive',
    'retention', 'retain', 'cancel', 'cancellation', 'membership', 'forever clean', 'downgrade', 'pause'
  ],

  formInstructions: function (drill) {
    return 'Approve or Deny speed drill. Target time: ' + drill.config.targetMinutes + ' minutes for all ' +
      drill.config.scenarioCount + ' tickets.\n\n' +
      'For each ticket, decide which retention action(s) the member qualifies for: Free month, MF reduction, ' +
      'ETF waiver, or None of the above. Then name the exact account detail that supports your decision and ' +
      'briefly explain it. Work from the ticket and account details only.';
  },

  questions: function () {
    return [
      {
        key: 'action', type: 'CHECKBOX', required: true,
        prompt: 'What action should be taken? Select every action the member qualifies for, or "None of the above".',
        choices: APPROVE_DENY_ACTIONS.slice(),
        scoring: { mode: 'AUTO', points: 2, method: 'EXACT_SET', gapTagOnWrong: 'INCORRECT_DECISION', criteria: 'Full credit only when the selected set exactly matches the answer key.' }
      },
      {
        key: 'accountDetail', type: 'SHORT_TEXT', required: true,
        prompt: 'What exact account detail supports your decision?',
        scoring: { mode: 'MANUAL', points: 2, method: 'TRAINER', gapTagOnWrong: 'MISSING_ACCOUNT_DETAIL', criteria: 'Names the specific account fact from the answer key (not a general policy statement).' }
      },
      {
        key: 'explanation', type: 'PARAGRAPH', required: true,
        prompt: 'Briefly explain your decision.',
        scoring: { mode: 'MANUAL', points: 1, method: 'TRAINER', gapTagOnWrong: 'WEAK_REASONING', criteria: 'Connects the account detail to the correct policy and does not rely on irrelevant facts.' }
      }
    ];
  },

  promptGuidance: function () {
    return [
      'Drill: "Approve or Deny". The trainee must decide which of these retention actions the member qualifies for: ' +
        APPROVE_DENY_ACTIONS.join(', ') + '. More than one action may apply only if the sources say they can be combined.',
      'correctActions must be chosen strictly from that list. Use "None of the above" alone, never combined with another action.',
      'requiredAccountDetail must be one concrete fact that appears verbatim (or nearly verbatim) in accountDetails or the ticket, e.g. a date, count, plan, or prior action.',
      'Include at least two relevant-looking but irrelevant facts and at least one conflicting signal so the trainee has to identify what matters.'
    ].join('\n');
  },

  outputSchema: function () {
    var schema = commonScenarioOutputSchema();
    schema.properties.correctActions = { type: 'array', items: { type: 'string', enum: APPROVE_DENY_ACTIONS } };
    schema.properties.requiredAccountDetail = { type: 'string' };
    schema.required.push('correctActions', 'requiredAccountDetail');
    return schema;
  },

  buildAnswerKey: function (out) {
    var actions = uniq(asArray(out.correctActions));
    return {
      correctAnswer: { action: actions, accountDetail: out.requiredAccountDetail || '' },
      correctDecision: actions.join(' + '),
      requiredAccountDetail: out.requiredAccountDetail || '',
      category: 'Membership retention',
      flags: []
    };
  },

  // Type-specific checks, re-run on every edit (see recomputeContentFlags).
  validate: function (scenario) {
    var actions = asArray((scenario.trainer.correctAnswer || {}).action);
    if (actions.indexOf('None of the above') !== -1 && actions.length > 1) {
      return ['"None of the above" is combined with another action in the correct answer.'];
    }
    return [];
  }
};

// Output fields every drill type asks the model for.
function commonScenarioOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      insufficientSource: { type: 'boolean' },
      insufficientReason: { type: 'string' },
      title: { type: 'string' },
      ticket: { type: 'string' },
      accountDetails: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: { label: { type: 'string' }, value: { type: 'string' } },
          required: ['label', 'value']
        }
      },
      rationale: { type: 'string' },
      commonMistakes: { type: 'array', items: { type: 'string' } },
      coachingNotes: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: { sectionId: { type: 'string' }, quote: { type: 'string' }, supports: { type: 'string' } },
          required: ['sectionId', 'quote', 'supports']
        }
      }
    },
    required: ['insufficientSource', 'insufficientReason', 'title', 'ticket', 'accountDetails', 'rationale', 'commonMistakes', 'coachingNotes', 'citations']
  };
}
