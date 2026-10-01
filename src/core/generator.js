// Scenario generation: prompt construction and conversion of model output into a
// structured scenario with trainee/trainer split and review flags.
//
// llm interface: await llm.generateJson({ system, user, schema }) -> parsed object.

var GENERATOR_SYSTEM_PROMPT = [
  'You write customer-service training tickets for Homeaglow Care trainees, plus the trainer answer key.',
  'Use ONLY the <source> sections provided: Knowledge Library sections (official policy) and CSQ Slack messages (recent clarifications from leads). Do not use outside knowledge of how retention or refunds "usually" work.',
  'For every claim in the answer key add a citation: the source id and a short quote copied word for word from that source. Never paraphrase inside a quote.',
  'If the Knowledge Library and a Slack message disagree, follow the more recent clarification and describe the disagreement in sourceConflict; otherwise leave sourceConflict empty.',
  'If the sources do not clearly give the correct answer, write a different ticket that they do cover. If none is possible, set insufficientSource to true and say what is missing in insufficientReason. Never invent a policy.',
  'STYLE. Write like the real sender (a customer or a cleaner partner, as the prompt says): short, plain, everyday words (easy for a new hire to read). Title: 3 to 6 words. Ticket: 2 to 4 short sentences, under 80 words. No long backstory.',
  'Account details: 3 to 6 short label/value pairs, each value a few words (for example "Plan: FCF $19/month", "Last cleaning: Sep 22, 2026").',
  'ACCOUNT DETAILS MUST BE REAL FIELDS that agents actually see in Homeaglow\'s CRM or CP tools (the prompt lists the usual ones). Never invent fields such as app version, device, browser, operating system or internal codes. You may include at most one real field that does not change the answer.',
  'Do not copy a process, tag or checklist name into the ticket or account details. Show the facts that point to it (status, dates, what happened) the way the tools show them.',
  'DATES. Use current dates. Every date must be within the last 12 months of today (scheduled cleanings may be up to 2 months ahead). Write dates like "Sep 22, 2026".',
  'Do not state the answer, name the policy, or hint at "the correct action" in the ticket or account details.',
  'Slack messages describe real cases. Use them to learn the rule, never copy them: invent new names, amounts, dates and IDs for every ticket.',
  'Trainer-only fields: rationale in 1 to 2 short sentences; at most 2 common mistakes, each one short line; coaching note in one sentence.'
].join('\n');

function buildGenerationPrompt(typeDef, ctx) {
  var parts = [];
  parts.push('Today is ' + humanDate(ctx.today) + '.');
  parts.push('AGENT SIDE: ' + getAudience(ctx.audience).short + '. The ticket is from ' + getAudience(ctx.audience).sender + '.');
  parts.push('Account detail fields agents see on this side: ' + getAudience(ctx.audience).fields.join(', ') + '.');
  if (ctx.topic) parts.push('TOPIC: every ticket in this drill must be about "' + ctx.topic + '". Use the sources about this topic.');
  parts.push(typeDef.promptGuidance(ctx));
  parts.push('Difficulty: ' + ctx.difficulty + ' — ' + (DIFFICULTY_GUIDANCE[ctx.difficulty] || ''));
  if (ctx.avoid && ctx.avoid.length) {
    parts.push('Already used in this drill (write something clearly different):\n' + ctx.avoid.map(function (t) { return '- ' + t; }).join('\n'));
  }
  if (ctx.trainerHint) parts.push('Trainer request for this scenario: ' + ctx.trainerHint);
  parts.push('Sources:\n\n' + formatSectionsForPrompt(ctx.sections));
  return { system: GENERATOR_SYSTEM_PROMPT, user: parts.join('\n\n') };
}

// Rules a draft must meet; any problem triggers one automatic rewrite.
function styleProblems(typeDef, ctx, out) {
  var problems = ctx.today ? checkReadability(out, ctx.today) : [];
  if (typeDef.styleCheck) problems = problems.concat(typeDef.styleCheck(out, ctx));
  return problems;
}

async function generateScenarioContent(typeDef, ctx, llm) {
  if (!ctx.sections || !ctx.sections.length) {
    throw ServiceError('NO_SOURCE_MATERIAL', 'No approved source sections matched this drill type. Import or refresh sources first.');
  }
  var prompt = buildGenerationPrompt(typeDef, ctx);
  var schema = typeDef.outputSchema(ctx);
  var output = await llm.generateJson({ system: prompt.system, user: prompt.user, schema: schema });
  var problems = checkJsonAgainstSchema(output, schema);
  if (problems.length) {
    throw ServiceError('BAD_MODEL_OUTPUT', 'Generated scenario did not match the expected structure: ' + problems.slice(0, 5).join('; '));
  }
  // One automatic rewrite when the ticket is too wordy or its dates are stale.
  var style = styleProblems(typeDef, ctx, output);
  if (style.length) {
    var retry = await llm.generateJson({
      system: prompt.system,
      user: prompt.user + '\n\nYour previous answer broke these rules. Fix them and keep the same answer key:\n- ' + style.join('\n- ') +
        '\n\nPrevious answer:\n' + JSON.stringify(output),
      schema: schema
    });
    if (!checkJsonAgainstSchema(retry, schema).length) output = retry;
  }
  return output;
}

// Turn model output (or a blank manual scenario when output is null) into the
// trainee and trainer parts plus review flags.
function buildScenarioParts(typeDef, ctx, output) {
  var questionsWithScoring = typeDef.questions(ctx);
  var flags = [];
  var out = output || {
    insufficientSource: false, insufficientReason: '', title: '', ticket: '', accountDetails: [],
    rationale: '', commonMistakes: [], coachingNotes: '', citations: []
  };

  if (!isBlank(out.sourceConflict)) {
    flags.push(makeFlag('SOURCE_CONFLICT', 'The Library and a Slack clarification disagree: ' + out.sourceConflict, false));
  }
  var styleLeft = output ? styleProblems(typeDef, ctx, out) : [];
  if (styleLeft.length) flags.push(makeFlag('STYLE', styleLeft.join(' '), false));
  if (out.insufficientSource) {
    flags.push(makeFlag('INSUFFICIENT_SOURCE', 'Generator reported the sources do not support an answer: ' + (out.insufficientReason || '(no reason given)'), true));
  }

  var key = typeDef.buildAnswerKey(out, ctx, questionsWithScoring);
  flags = flags.concat(key.flags || []);
  var finalQuestions = key.questions || questionsWithScoring;

  var verifiedSources = verifyCitations(out.citations || [], ctx.sections || []);
  if (key.catalogSources) verifiedSources = verifiedSources.concat(deepClone(key.catalogSources));
  if (output) {
    flags = flags.concat(sourceFlags(verifiedSources, (ctx.sections || []).length > 0));
  } else {
    flags.push(makeFlag('MANUAL_ENTRY', 'Manually written scenario. Add the source reference for the answer key, then resolve this flag.', true));
  }

  var scoring = {};
  finalQuestions.forEach(function (q) { scoring[q.key] = deepClone(q.scoring); });

  var trainee = {
    title: out.title || '',
    scenario: out.ticket || '',
    accountDetails: deepClone(out.accountDetails || []),
    traineeInstructions: '',
    questions: finalQuestions.map(function (q) {
      return { key: q.key, prompt: q.prompt, type: q.type, choices: deepClone(q.choices || []), required: q.required !== false, helpText: q.helpText || '' };
    })
  };

  var trainer = {
    correctAnswer: key.correctAnswer || {},
    correctDecision: key.correctDecision || '',
    requiredAccountDetail: key.requiredAccountDetail || '',
    rationale: out.rationale || '',
    sources: verifiedSources,
    scoring: scoring,
    scoringCriteria: finalQuestions.map(function (q) { return q.prompt + ' — ' + (q.scoring.mode === 'AUTO' ? 'auto' : 'manual') + ', ' + q.scoring.points + ' pt: ' + q.scoring.criteria; }),
    commonMistakes: deepClone(out.commonMistakes || []),
    coachingNotes: out.coachingNotes || '',
    trainerNotes: '',
    catalogId: key.catalogId || null
  };

  return { trainee: trainee, trainer: trainer, category: key.category || ctx.category || null, flags: flags };
}

// Re-derive the flags that depend on current content. Source flags that a trainer
// resolved stay resolved; content flags are recomputed and cannot be waived.
function recomputeContentFlags(scenario) {
  var keep = (scenario.reviewFlags || []).filter(function (f) {
    return ['ANSWER_LEAK', 'INVALID_SCENARIO'].indexOf(f.code) === -1;
  });
  var leaks = findTraineeLeaks(toTraineeVersion(scenario), scenario.trainer);
  if (leaks.length) keep.push(makeFlag('ANSWER_LEAK', leaks.join(' '), true, false));
  var errors = validateScenario(scenario);
  var typeDef = scenario.drillType ? getDrillType(scenario.drillType) : null;
  if (typeDef && typeDef.validate) errors = errors.concat(typeDef.validate(scenario));
  if (errors.length) keep.push(makeFlag('INVALID_SCENARIO', errors.join(' '), true, false));
  scenario.reviewFlags = keep;
  return scenario;
}

async function proposeCatalogEntries(typeDef, sections, llm, audienceId) {
  if (!sections.length) throw ServiceError('NO_SOURCE_MATERIAL', 'No source sections matched the triage keywords. Refresh sources first.');
  var schema = typeDef.catalogOutputSchema(audienceId);
  var out = await llm.generateJson({
    system: GENERATOR_SYSTEM_PROMPT,
    user: typeDef.catalogPromptGuidance(audienceId) + '\n\nApproved sources:\n\n' + formatSectionsForPrompt(sections),
    schema: schema
  });
  var problems = checkJsonAgainstSchema(out, schema);
  if (problems.length) throw ServiceError('BAD_MODEL_OUTPUT', 'Catalog output did not match the expected structure: ' + problems.slice(0, 5).join('; '));
  return (out.entries || []).map(function (e) {
    var sources = verifyCitations(e.citations || [], sections);
    var verified = sources.some(function (s) { return s.verified; });
    return {
      name: shortProcessName(e.name), sourceTitle: e.sourceTitle || e.name, tag: e.tag || '', checklist: e.checklist || '', category: e.category, whenToUse: e.whenToUse || '',
      sources: sources,
      flags: verified ? [] : [makeFlag('UNVERIFIED_SOURCE', 'No cited quote was found in the sources.', true)]
    };
  });
}
