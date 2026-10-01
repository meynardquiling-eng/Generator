// Drill 2 — "Triage-Only" drill (30 minutes, mixed tickets).
// Trainees identify the process, the tag and the checklist; they do not write a reply.
//
// Answer choices are NOT hardcoded. They come from the process catalog, which is
// extracted from the approved sources (each entry carries a verified quote) and approved
// by a trainer before any triage drill can be generated.

var TRIAGE_CATEGORIES = ['Unused-voucher issue', 'Lock-out refund', 'Voucher refund', 'General retention'];

var TRIAGE_TYPE = {
  type: 'TRIAGE',
  name: 'Triage-Only',
  description: 'Identify the correct process, tag and interactive checklist for a mix of tickets. No customer reply is written.',
  drillIdPrefix: 'TRIAGE',
  scenarioIdPrefix: 'TR',
  cadence: 'AD_HOC',
  defaults: { scenarioCount: 8, targetMinutes: 30, difficulty: 'MEDIUM' },
  requiresCatalog: true,
  categories: TRIAGE_CATEGORIES,
  sourceKeywords: [
    'unused voucher', 'voucher', 'lock-out', 'lockout', 'locked out', 'refund', 'retention',
    'checklist', 'interactive checklist', 'tag', 'process', 'macro', 'workflow', 'triage'
  ],

  formInstructions: function (drill) {
    return 'Triage \u2014 about ' + drill.config.targetMinutes + ' minutes. Do not write a reply.\n' +
      'For each ticket: pick the process, the tag and the checklist to launch.';
  },

  // ctx.catalog: approved catalog entries.
  questions: function (ctx) {
    var catalog = ctx.catalog || [];
    var names = uniq(catalog.map(function (c) { return c.name; }).filter(Boolean));
    var tags = uniq(catalog.map(function (c) { return c.tag; }).filter(Boolean));
    var checklists = uniq(catalog.map(function (c) { return c.checklist; }).filter(Boolean));
    var qs = [{
      key: 'process', type: 'MULTIPLE_CHOICE', required: true,
      prompt: 'Which process?', choices: names,
      scoring: { mode: 'AUTO', points: 2, method: 'EXACT', gapTagOnWrong: 'INCORRECT_PROCESS', criteria: 'Matches the documented process for this ticket.' }
    }];
    if (tags.length >= 2) {
      qs.push({
        key: 'tag', type: 'MULTIPLE_CHOICE', required: true,
        prompt: 'Which tag?', choices: tags,
        scoring: { mode: 'AUTO', points: 1, method: 'EXACT', gapTagOnWrong: 'INCORRECT_TAG', criteria: 'Matches the documented tag for the process.' }
      });
    }
    if (checklists.length >= 2) {
      qs.push({
        key: 'checklist', type: 'MULTIPLE_CHOICE', required: true,
        prompt: 'Which checklist?', choices: checklists,
        scoring: { mode: 'AUTO', points: 1, method: 'EXACT', gapTagOnWrong: 'INCORRECT_CHECKLIST', criteria: 'Matches the documented interactive checklist for the process.' }
      });
    }
    qs.push({
      key: 'reasoning', type: 'SHORT_TEXT', required: false,
      prompt: 'What told you? (optional)',
      scoring: { mode: 'MANUAL', points: 0, method: 'TRAINER', gapTagOnWrong: 'WEAK_REASONING', criteria: 'Not scored; used for coaching.' }
    });
    return qs;
  },

  promptGuidance: function (ctx) {
    var list = (ctx.catalog || []).map(function (c) {
      return '- id=' + c.catalogId + ' | process="' + c.name + '" | tag="' + (c.tag || '') + '" | checklist="' + (c.checklist || '') +
        '" | category="' + (c.category || '') + '" | when to use: ' + (c.whenToUse || '');
    }).join('\n');
    return [
      'Drill: "Triage-Only". The trainee does not reply to the customer; they only pick the process, tag and checklist.',
      'Approved process catalog (the ONLY valid answers):\n' + list,
      'correctProcessId must be one of the catalog ids above. Ticket category should be: ' + (ctx.category || 'any of ' + TRIAGE_CATEGORIES.join(', ')) + '.',
      'Write the ticket so that surface keywords point toward a plausible but wrong process at least some of the time; the account facts must decide it.',
      'requiredAccountDetail is the single fact that determines the process.'
    ].join('\n\n');
  },

  outputSchema: function (ctx) {
    var schema = commonScenarioOutputSchema();
    var ids = (ctx.catalog || []).map(function (c) { return c.catalogId; });
    schema.properties.category = { type: 'string', enum: TRIAGE_CATEGORIES };
    schema.properties.correctProcessId = ids.length ? { type: 'string', enum: ids } : { type: 'string' };
    schema.properties.requiredAccountDetail = { type: 'string' };
    schema.required.push('category', 'correctProcessId', 'requiredAccountDetail');
    return schema;
  },

  buildAnswerKey: function (out, ctx, questions) {
    var entry = (ctx.catalog || []).filter(function (c) { return c.catalogId === out.correctProcessId; })[0];
    var flags = [];
    if (!entry) {
      flags.push(makeFlag('UNKNOWN_PROCESS', 'The generator chose a process that is not in the approved catalog.', true, false));
      return { correctAnswer: {}, correctDecision: '', requiredAccountDetail: out.requiredAccountDetail || '', category: out.category, flags: flags, questions: questions };
    }
    var correct = { process: entry.name, reasoning: out.requiredAccountDetail || '' };
    // Only ask about a tag/checklist the source documents for this process.
    var qs = questions.filter(function (q) {
      if (q.key === 'tag') return !isBlank(entry.tag);
      if (q.key === 'checklist') return !isBlank(entry.checklist);
      return true;
    });
    if (!isBlank(entry.tag)) correct.tag = entry.tag;
    if (!isBlank(entry.checklist)) correct.checklist = entry.checklist;
    return {
      correctAnswer: correct,
      correctDecision: entry.name + (entry.tag ? ' / tag: ' + entry.tag : '') + (entry.checklist ? ' / checklist: ' + entry.checklist : ''),
      requiredAccountDetail: out.requiredAccountDetail || '',
      category: out.category,
      catalogId: entry.catalogId,
      catalogSources: entry.sources || [],
      flags: flags,
      questions: qs
    };
  },

  catalogPromptGuidance: function () {
    return [
      'Extract the list of documented ticket-handling processes relevant to these categories: ' + TRIAGE_CATEGORIES.join(', ') + '.',
      'For each process give its exact name as written in the source, the exact tag to apply (empty string if the source does not name one), ',
      'the exact interactive checklist/process to launch (empty string if not documented), the best-fitting category, and when to use it.',
      'Do not invent processes, tags or checklists. Every entry needs at least one verbatim quote from the sources.'
    ].join('');
  },

  catalogOutputSchema: function () {
    return {
      type: 'object', additionalProperties: false,
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string' }, tag: { type: 'string' }, checklist: { type: 'string' },
              category: { type: 'string', enum: TRIAGE_CATEGORIES }, whenToUse: { type: 'string' },
              citations: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: { sectionId: { type: 'string' }, quote: { type: 'string' }, supports: { type: 'string' } },
                  required: ['sectionId', 'quote', 'supports']
                }
              }
            },
            required: ['name', 'tag', 'checklist', 'category', 'whenToUse', 'citations']
          }
        }
      },
      required: ['entries']
    };
  }
};
