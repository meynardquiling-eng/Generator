// Scenario generation: prompt construction and conversion of model output into a
// structured scenario with trainee/trainer split and review flags.
//
// llm interface: await llm.generateJson({ system, user, schema }) -> parsed object.

var GENERATOR_SYSTEM_PROMPT = [
  'You write realistic customer-service training scenarios for Homeaglow Care trainees, plus the trainer answer key.',
  'Ground every policy statement in the <source> sections provided. They are the only approved policy. Do not use outside knowledge of how retention or refunds "usually" work.',
  'For every claim in the answer key (the decision, the rationale, and why the required account detail matters) add a citation: the source id and a short quote copied verbatim from that source. Never paraphrase inside a quote.',
  'If the sources do not clearly establish the correct answer for the scenario you want to write, write a different scenario that they do cover. If none is possible, set insufficientSource to true and explain what is missing in insufficientReason. Never fill a gap with a plausible-sounding policy.',
  'The ticket must read like a real customer message (first person, natural tone). Put the facts an agent would see in their tools into accountDetails as short label/value pairs: plan, dates, payment history, visits, prior agent actions, notes.',
  'Make the scenario hard through its facts, not through convoluted wording. Do not state the answer, hint at the policy name, or mention "the correct action" anywhere in the ticket or account details.',
  'rationale, commonMistakes and coachingNotes are for the trainer only and should be specific to this case.'
].join('\n');

function buildGenerationPrompt(typeDef, ctx) {
  var parts = [];
  parts.push(typeDef.promptGuidance(ctx));
  parts.push('Difficulty: ' + ctx.difficulty + ' — ' + (DIFFICULTY_GUIDANCE[ctx.difficulty] || ''));
  if (ctx.avoid && ctx.avoid.length) {
    parts.push('Already used in this drill (write something clearly different):\n' + ctx.avoid.map(function (t) { return '- ' + t; }).join('\n'));
  }
  if (ctx.trainerHint) parts.push('Trainer request for this scenario: ' + ctx.trainerHint);
  parts.push('Approved sources:\n\n' + formatSectionsForPrompt(ctx.sections));
  return { system: GENERATOR_SYSTEM_PROMPT, user: parts.join('\n\n') };
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

async function proposeCatalogEntries(typeDef, sections, llm) {
  if (!sections.length) throw ServiceError('NO_SOURCE_MATERIAL', 'No source sections matched the triage keywords. Refresh sources first.');
  var schema = typeDef.catalogOutputSchema();
  var out = await llm.generateJson({
    system: GENERATOR_SYSTEM_PROMPT,
    user: typeDef.catalogPromptGuidance() + '\n\nApproved sources:\n\n' + formatSectionsForPrompt(sections),
    schema: schema
  });
  var problems = checkJsonAgainstSchema(out, schema);
  if (problems.length) throw ServiceError('BAD_MODEL_OUTPUT', 'Catalog output did not match the expected structure: ' + problems.slice(0, 5).join('; '));
  return (out.entries || []).map(function (e) {
    var sources = verifyCitations(e.citations || [], sections);
    var verified = sources.some(function (s) { return s.verified; });
    return {
      name: e.name, tag: e.tag || '', checklist: e.checklist || '', category: e.category, whenToUse: e.whenToUse || '',
      sources: sources,
      flags: verified ? [] : [makeFlag('UNVERIFIED_SOURCE', 'No cited quote was found in the sources.', true)]
    };
  });
}
