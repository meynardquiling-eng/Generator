// Drill 1 — "Approve or Deny" speed drill (daily, 5 complex membership tickets, 15 minutes).

// Every offer or action a C-side agent can take on a membership ticket, as the Knowledge
// Library groups them: retention (keep the membership), exit (close it out fairly) and
// make-right (fix a charge we caused).
var APPROVE_DENY_ACTION_GROUPS = [
  { group: 'Retention', actions: ['Voucher or credit', 'MF reduction', 'MCT reduction', 'Free month', 'Pause membership', 'Set Max CP Rate'] },
  { group: 'Exit', actions: ['ETF reduction', 'ETF waiver', 'MF refund', 'Cancel membership'] },
  { group: 'Make-right', actions: ['Refund a fee (LMC, lockout or priority)'] }
];
var APPROVE_DENY_ACTIONS = APPROVE_DENY_ACTION_GROUPS.reduce(function (all, g) { return all.concat(g.actions); }, []).concat(['None of the above']);

var APPROVE_DENY_TYPE = {
  type: 'APPROVE_DENY',
  name: 'Approve or Deny',
  description: 'Decide which offer or action the member qualifies for and name the account detail that proves it.',
  drillIdPrefix: 'APPROVE-DENY',
  scenarioIdPrefix: 'AD',
  cadence: 'DAILY',
  defaults: { scenarioCount: 5, targetMinutes: 15, difficulty: 'HARD' },
  requiresCatalog: false,
  audiences: ['CUSTOMER'],
  sourceKeywords: [
    'free month', 'mf reduction', 'membership fee', 'etf', 'early termination', 'waiver', 'waive',
    'retention', 'retain', 'cancel', 'cancellation', 'membership', 'forever clean', 'downgrade', 'pause',
    'mct', 'minimum commitment', 'voucher', 'credit', 'max cp rate', 'refund', 'offer', 'exit offer', 'make-right'
  ],

  formInstructions: function (drill) {
    return 'Approve or Deny \u2014 ' + drill.config.scenarioCount + ' tickets, about ' + drill.config.targetMinutes + ' minutes.\n' +
      'For each ticket: pick the offer or action, name the account detail that proves it, and say why in a sentence.';
  },

  questions: function () {
    return [
      {
        key: 'action', type: 'CHECKBOX', required: true,
        prompt: 'What should you offer or do? (pick all that apply)',
        choices: APPROVE_DENY_ACTIONS.slice(),
        scoring: { mode: 'AUTO', points: 2, method: 'EXACT_SET', gapTagOnWrong: 'INCORRECT_DECISION', criteria: 'Full credit only when the picks match the answer key exactly.' }
      },
      {
        key: 'accountDetail', type: 'SHORT_TEXT', required: true,
        prompt: 'Which account detail tells you?',
        scoring: { mode: 'MANUAL', points: 2, method: 'TRAINER', gapTagOnWrong: 'MISSING_ACCOUNT_DETAIL', criteria: 'Names the exact account fact, not a general policy.' }
      },
      {
        key: 'explanation', type: 'PARAGRAPH', required: true,
        prompt: 'Why? (1\u20132 sentences)',
        scoring: { mode: 'MANUAL', points: 1, method: 'TRAINER', gapTagOnWrong: 'WEAK_REASONING', criteria: 'Links the detail to the right policy.' }
      }
    ];
  },

  promptGuidance: function () {
    return [
      'Drill: "Approve or Deny". The trainee must decide which offers or actions the member qualifies for. The full list, by type: ' +
        APPROVE_DENY_ACTION_GROUPS.map(function (g) { return g.group + ': ' + g.actions.join(', '); }).join('; ') + '.',
      'Pick the answer the sources support for this exact situation. More than one action may apply only if the sources say they can be combined ' +
        '(e.g. Cancel membership together with ETF waiver). Vary the correct answer across tickets; do not default to Free month.',
      'correctActions must be chosen strictly from that list. Use "None of the above" alone, never combined with another action; it means the agent should only explain, with no offer or account action.',
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
      },
      sourceConflict: { type: 'string' }
    },
    required: ['insufficientSource', 'insufficientReason', 'title', 'ticket', 'accountDetails', 'rationale', 'commonMistakes', 'coachingNotes', 'citations', 'sourceConflict']
  };
}
