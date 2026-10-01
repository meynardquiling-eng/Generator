// Drill 2 — "Triage-Only" drill (30 minutes, mixed tickets).
// Trainees identify the process, the tag and the checklist; they do not write a reply.
//
// Answer choices are NOT hardcoded. They come from the process catalog, which is
// extracted from the approved sources (each entry carries a verified quote) and approved
// by a trainer before any triage drill can be generated.

var TRIAGE_CATEGORIES = ['Unused-voucher issue', 'Lock-out refund', 'Voucher refund', 'General retention'];
var TRIAGE_CATEGORIES_BY_AUDIENCE = {
  CUSTOMER: TRIAGE_CATEGORIES,
  CP: ['CP lockout', 'Payout issue', 'Job claim or cancellation', 'Account or deactivation']
};

function triageCategories(audienceId) {
  return TRIAGE_CATEGORIES_BY_AUDIENCE[audienceId] || TRIAGE_CATEGORIES;
}

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
  categoriesByAudience: TRIAGE_CATEGORIES_BY_AUDIENCE,
  audiences: ['CUSTOMER', 'CP'],
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
      'correctProcessId must be one of the catalog ids above. Aim for this category: ' + (ctx.category || 'any of ' + triageCategories(ctx.audience).join(', ')) + '. Then set "category" to whichever category (' + triageCategories(ctx.audience).join(', ') + ') really fits the ticket you wrote.',
      'Write the ticket so that surface keywords point toward a plausible but wrong process at least some of the time; the account facts must decide it.',
      'requiredAccountDetail is the single fact that determines the process.'
    ].join('\n\n');
  },

  outputSchema: function (ctx) {
    var schema = commonScenarioOutputSchema();
    var ids = (ctx.catalog || []).map(function (c) { return c.catalogId; });
    schema.properties.category = { type: 'string', enum: triageCategories(ctx.audience) };
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

  // A multi-word process, a tag or a checklist name copied into the ticket gives the answer away.
  styleCheck: function (out, ctx) {
    var choices = [];
    (ctx.catalog || []).forEach(function (c) { choices.push(c.name, c.tag, c.checklist); });
    return giveawayProblems(out.ticket, out.accountDetails, choices);
  },

  validate: function (scenario) {
    var choices = [];
    (scenario.trainee.questions || []).forEach(function (q) { choices = choices.concat(q.choices || []); });
    return giveawayProblems(scenario.trainee.scenario, scenario.trainee.accountDetails, choices);
  },

  catalogPromptGuidance: function (audienceId) {
    return [
      'Extract the list of documented ticket-handling processes ' + (audienceId === 'CP' ? 'that CP-side agents use for tickets from cleaner partners (CPs)' : 'that C-side agents use for customer tickets') +
        ', relevant to these categories: ' + triageCategories(audienceId).join(', ') + '. ',
      'For each process give: name = a short label of 2 to 5 key words taken from the source heading, dropping filler such as "Process guide", "How to", "if C wants" ',
      '(example: "Process Guide if C wants a Groupon Voucher refunded" becomes "Groupon voucher refund"); sourceTitle = the heading exactly as written in the source; ',
      'the exact tag to apply (empty string if the source does not name one); the exact interactive checklist/process to launch (empty string if not documented); ',
      'the best-fitting category; when to use it in one short line; and kind.',
      'kind = "PROCESS" only when the source gives steps an agent follows to handle a ticket. ',
      'Reference material is NOT a process: code lists, reason codes, penalty ladders, strike or warning tiers, rate or fee tables, matrices, glossaries, definitions, overviews and FAQs. ',
      'Mark those kind = "REFERENCE" (they are not answer choices). ',
      'Do not invent processes, tags or checklists. Every entry needs at least one verbatim quote from the sources.'
    ].join('');
  },

  catalogOutputSchema: function (audienceId) {
    return {
      type: 'object', additionalProperties: false,
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string' }, sourceTitle: { type: 'string' }, tag: { type: 'string' }, checklist: { type: 'string' },
              category: { type: 'string', enum: triageCategories(audienceId) }, whenToUse: { type: 'string' },
              kind: { type: 'string', enum: ['PROCESS', 'REFERENCE'] },
              citations: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: { sectionId: { type: 'string' }, quote: { type: 'string' }, supports: { type: 'string' } },
                  required: ['sectionId', 'quote', 'supports']
                }
              }
            },
            required: ['name', 'sourceTitle', 'tag', 'checklist', 'category', 'whenToUse', 'kind', 'citations']
          }
        }
      },
      required: ['entries']
    };
  }
};

// Short trainee-facing process label from a Knowledge Library heading, used when the
// generator returns a long name: "Process Guide if C wants a Groupon Voucher refunded"
// -> "Groupon Voucher refund".
var PROCESS_FILLER = [
  /^\s*(?:\p{Extended_Pictographic}|[^\w\s])+\s*/u,
  /^(?:the\s+)?(?:process\s+guide|guide|process|sop|workflow|how\s+to\s+handle|how\s+to)\s*(?:for|on|if|when|to|:|-|\u2013|\u2014)?\s*/i,
  /^(?:if|when)\s+/i,
  /^(?:the\s+)?(?:c|cx|customer|member)\s+(?:wants|asks|requests|is\s+asking)\s+(?:for\s+|to\s+(?:have\s+|get\s+)?)?(?:a|an|the|their|his|her)?\s*/i
];

var PROCESS_NAME_VERSION = 3;

// Knowledge Library headings that are lookup material, not a process an agent runs.
var REFERENCE_TITLE_RE = /\b(reason\s+codes?|codes?\s+(?:list|table)|ladders?|matrix|matrices|tables?|glossary|definitions?|overview|faqs?|cheat\s*sheet|list\s+of|rate\s+card)\b/i;

function isReferenceEntry(e) {
  if (e.kind === 'REFERENCE') return true;
  return REFERENCE_TITLE_RE.test(String(e.name || '')) || REFERENCE_TITLE_RE.test(String(e.sourceTitle || ''));
}

function shortProcessName(name) {
  var s = String(name || '').trim();
  for (var pass = 0; pass < 3; pass++) {
    PROCESS_FILLER.forEach(function (re) { s = s.replace(re, ''); });
  }
  s = s.replace(/\s+(?:process|guide|procedure)$/i, '').replace(/\brefunded\b/i, 'refund').replace(/\s+/g, ' ').trim();
  var words = s.split(' ');
  if (words.length > 6) s = words.slice(0, 6).join(' ');
  if (!s) return String(name || '').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function giveawayProblems(ticket, accountDetails, choices) {
  var text = normalizeText([ticket].concat((accountDetails || []).map(function (d) { return d.label + ': ' + d.value; })).join(' \n '));
  return uniq((choices || []).filter(function (c) {
    if (isBlank(c)) return false;
    var n = normalizeText(c);
    return (n.indexOf(' ') !== -1 || n.indexOf('_') !== -1) && text.indexOf(n) !== -1;
  })).map(function (c) { return 'The ticket or account details contain the answer choice "' + c + '" word for word.'; });
}
