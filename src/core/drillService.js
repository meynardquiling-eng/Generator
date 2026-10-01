// Trainer-side drill workflow. Everything the dashboard does goes through here.
//
// deps:
//   store  { get(coll, id), list(coll, [field, value]?), put(coll, id, obj), remove(coll, id), lease(key, holder, ttlMs) }
//   bridge { requestForm(folderId, drillId, spec), getFormResult(folderId, drillId), getResponses(folderId, drillId),
//            requestSourceExport(folderId), getSourceExport(folderId) }   <- Google Drive / Apps Script Form Bridge
//   llm    { generateJson({ system, user, schema }) }
//   slack  { readChannel(channelId) }  (optional)
//   clock  { nowIso(), today() }
//   actor  stable id of the trainer using the dashboard
//
// The three data layers stay separate: scenarios (canonical answer key) live in
// `scenarios`, the trainee-facing form spec is derived on demand and handed to the
// bridge, and submissions live in `responses`. Nothing in the response path writes to
// `scenarios`.

var AUDIT_LIMIT = 300;
var SOURCE_CHUNK_CHARS = 150000;
var SOURCE_PROMPT_CHARS = 60000;
var SLACK_STALE_MS = 6 * 3600 * 1000;
var SLACK_DAYS = 45;
var DEFAULT_CSQ_CHANNELS = [
  { id: 'C0BL531GV0R', name: 'csq-claude-escalations' },
  { id: 'C0B6W0XPQE4', name: 'csq-customer-care-control' },
  { id: 'C0ASLRNN1RA', name: 'training_cohort-3-30-csq' },
  { id: 'C096318TMDX', name: 'rr-tone-and-voice-csq' }
];

function csqChannels(settings) {
  return settings && settings.csqChannels && settings.csqChannels.length ? settings.csqChannels : DEFAULT_CSQ_CHANNELS;
}

function createDrillService(deps) {
  var store = deps.store;
  var bridge = deps.bridge;
  var llm = deps.llm;
  var clock = deps.clock;
  var actor = deps.actor || 'unknown';

  function now() { return clock.nowIso(); }

  async function withLock(key, fn) {
    for (var attempt = 0; attempt < 8; attempt++) {
      if (await store.lease('locks__' + key, actor, 8000)) return await fn();
      await sleep(750);
    }
    throw ServiceError('BUSY', 'Another trainer is changing this drill right now. Try again in a few seconds.');
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, deps.sleepMs != null ? deps.sleepMs : ms); });
  }

  function audit(drill, action, details) {
    drill.audit = drill.audit || [];
    drill.audit.push({ at: now(), by: actor, action: action, details: details || null });
    if (drill.audit.length > AUDIT_LIMIT) drill.audit = drill.audit.slice(-AUDIT_LIMIT);
  }

  async function getSettings() {
    return (await store.get(COLLECTIONS.settings, 'main')) || {
      bridgeFolderId: '', collectVerifiedEmail: true, csqChannels: [], sourceDocId: '1igeJMGuPe2t4ajDmQTOOitb5amy68gY6q4ImWVoaNf8'
    };
  }

  async function requireFolder() {
    var s = await getSettings();
    if (isBlank(s.bridgeFolderId)) throw ServiceError('NOT_CONFIGURED', 'Set the Form Bridge Drive folder ID in Settings first.');
    return s;
  }

  async function getDrill(drillId) {
    var d = await store.get(COLLECTIONS.drills, drillId);
    if (!d) throw ServiceError('NOT_FOUND', 'Drill ' + drillId + ' not found.');
    return d;
  }

  async function saveDrill(drill) {
    drill.updatedAt = now();
    await store.put(COLLECTIONS.drills, drill.drillId, drill);
    return drill;
  }

  async function listScenarios(drillId) {
    var all = await store.list(COLLECTIONS.scenarios, ['drillId', drillId]);
    return all.sort(function (a, b) { return a.scenarioId < b.scenarioId ? -1 : 1; });
  }

  async function getScenario(drillId, scenarioId) {
    var s = await store.get(COLLECTIONS.scenarios, scenarioDocId(drillId, scenarioId));
    if (!s) throw ServiceError('NOT_FOUND', 'Scenario ' + scenarioId + ' not found in ' + drillId + '.');
    return s;
  }

  async function saveScenario(s) {
    s.updatedAt = now();
    await store.put(COLLECTIONS.scenarios, scenarioDocId(s.drillId, s.scenarioId), s);
    return s;
  }

  // ---- sources -------------------------------------------------------------

  async function getAllSections() {
    var chunks = await store.list(COLLECTIONS.sources);
    var sections = [];
    chunks.sort(function (a, b) { return a.chunkId < b.chunkId ? -1 : 1; }).forEach(function (c) {
      sections = sections.concat(c.sections || []);
    });
    return sections;
  }

  async function approvedCatalog() {
    return (await store.list(COLLECTIONS.catalog, ['status', 'APPROVED']))
      .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  }

  async function buildContext(drill, typeDef, opts, scenarios) {
    opts = opts || {};
    var topic = (drill.config && drill.config.topic) || '';
    var all = await getAllSections();
    if (topic && all.length && !sectionsMatchingTopic(all, topic).length) {
      throw ServiceError('NO_SOURCE_MATERIAL', 'Nothing in the Knowledge Library or CSQ Slack mentions "' + topic + '". Try a different wording for the topic.');
    }
    var sections = selectSections(all, typeDef.sourceKeywords, SOURCE_PROMPT_CHARS, topicKeywords(topic));
    var catalog = typeDef.requiresCatalog ? await ensureCatalog() : [];
    var active = activeScenarios(scenarios || []);
    var category = opts.category || null;
    if (!category && !topic && typeDef.categories) {
      category = typeDef.categories[active.length % typeDef.categories.length];
    }
    return {
      drill: drill,
      topic: topic,
      today: clock.today(),
      difficulty: opts.difficulty || drill.config.difficulty,
      sections: sections,
      catalog: catalog,
      category: category,
      trainerHint: opts.trainerHint || '',
      avoid: active.filter(function (s) { return s.scenarioId !== opts.excludeScenarioId; })
        .map(function (s) { return s.trainee.title || s.trainee.scenario.slice(0, 80); })
    };
  }

  // Any trainee-content change on an approved drill withdraws the approval.
  function markEdited(drill, what) {
    if (drill.status === DrillStatus.APPROVED) {
      transitionDrill(drill, DrillStatus.TRAINER_REVIEW, actor, now());
      drill.approval = null;
      audit(drill, 'APPROVAL_WITHDRAWN', what);
    } else if (drill.status === DrillStatus.GENERATED) {
      transitionDrill(drill, DrillStatus.TRAINER_REVIEW, actor, now());
    }
  }

  function requireEditable(drill) {
    if (!isTraineeContentEditable(drill.status)) {
      throw ServiceError('LOCKED', 'The Google Form for ' + drill.drillId + ' has been created, so trainee-facing content is locked. Answer-key fields can still be corrected.');
    }
  }

  // ---- drills --------------------------------------------------------------

  async function createDrill(input) {
    var typeDef = getDrillType(input.drillType);
    var today = clock.today();
    return withLock('new__' + typeDef.drillIdPrefix + '__' + today, async function () {
      var sameDay = (await store.list(COLLECTIONS.drills, ['drillDate', today]))
        .concat(await store.list(COLLECTIONS.deletedDrills, ['drillDate', today]));
      var drillId = makeDrillId(typeDef.drillIdPrefix, today, sameDay.map(function (d) { return d.drillId; }));
      while (await store.get(COLLECTIONS.drills, drillId)) {
        drillId = makeDrillId(typeDef.drillIdPrefix, today, sameDay.map(function (d) { return d.drillId; }).concat([drillId]));
      }
      var count = parseInt(input.scenarioCount, 10) || typeDef.defaults.scenarioCount;
      var topic = String(input.topic || '').trim().slice(0, 80);
      var drill = {
        drillId: drillId, drillType: typeDef.type, drillDate: today,
        title: input.title || (topic ? typeDef.name + ' · ' + topic : typeDef.name),
        status: DrillStatus.DRAFT,
        config: {
          scenarioCount: Math.max(1, Math.min(count, 25)),
          difficulty: DIFFICULTY_GUIDANCE[input.difficulty] ? input.difficulty : typeDef.defaults.difficulty,
          targetMinutes: parseInt(input.targetMinutes, 10) || typeDef.defaults.targetMinutes,
          topic: topic
        },
        nextScenarioSeq: 1,
        createdAt: now(), createdBy: actor, updatedAt: now(),
        statusHistory: [], audit: [], approval: null, form: null, responseStats: null, sentAt: null
      };
      audit(drill, 'CREATED', drill.config);
      await store.put(COLLECTIONS.drills, drillId, drill);
      return drill;
    });
  }

  async function listDrills() {
    var drills = await store.list(COLLECTIONS.drills);
    return drills.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).map(function (d) {
      return {
        drillId: d.drillId, drillType: d.drillType, title: d.title, status: d.status, createdAt: d.createdAt,
        drillDate: d.drillDate, scenarioCount: d.config.scenarioCount, topic: d.config.topic || '',
        formStatus: d.form ? d.form.state : 'NONE', formUrl: d.form && d.form.publishedUrl,
        submissions: d.responseStats ? d.responseStats.responses : 0,
        trainees: d.responseStats ? d.responseStats.trainees : 0,
        pendingReview: d.responseStats ? d.responseStats.pendingReview : 0
      };
    });
  }

  async function getDrillBundle(drillId) {
    var drill = await getDrill(drillId);
    var scenarios = await listScenarios(drillId);
    var responses = await store.list(COLLECTIONS.responses, ['drillId', drillId]);
    responses.sort(function (a, b) { return a.submittedAt < b.submittedAt ? -1 : 1; });
    return { drill: drill, scenarios: scenarios, responses: responses };
  }

  // ---- scenarios -----------------------------------------------------------

  function newScenarioRecord(drill, typeDef, scenarioId, parts, generatedBy, difficulty) {
    var s = {
      scenarioUid: makeScenarioUid(drill.drillId, scenarioId),
      scenarioId: scenarioId, drillId: drill.drillId, drillType: drill.drillType,
      version: 1, status: 'ACTIVE', difficulty: difficulty, category: parts.category,
      generatedBy: generatedBy, createdAt: now(), updatedAt: now(),
      reviewFlags: parts.flags, trainee: parts.trainee, trainer: parts.trainer, history: []
    };
    return recomputeContentFlags(s);
  }

  async function addScenario(drillId, parts, generatedBy, difficulty) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      requireEditable(drill);
      var typeDef = getDrillType(drill.drillType);
      var scenarioId = makeScenarioId(typeDef.scenarioIdPrefix, drill.nextScenarioSeq);
      drill.nextScenarioSeq += 1;
      // Reserve the ID before writing the scenario so a failed write can never cause reuse.
      if (drill.status === DrillStatus.DRAFT) transitionDrill(drill, DrillStatus.GENERATED, actor, now());
      else if (drill.status === DrillStatus.APPROVED) markEdited(drill, 'Scenario ' + scenarioId + ' added');
      audit(drill, generatedBy === 'MANUAL' ? 'SCENARIO_ADDED_MANUALLY' : 'SCENARIO_GENERATED', { scenarioId: scenarioId });
      await saveDrill(drill);
      var s = newScenarioRecord(drill, typeDef, scenarioId, parts, generatedBy, difficulty || drill.config.difficulty);
      await saveScenario(s);
      return s;
    });
  }

  async function generateNextScenario(drillId, opts) {
    var drill = await getDrill(drillId);
    requireEditable(drill);
    var typeDef = getDrillType(drill.drillType);
    var scenarios = await listScenarios(drillId);
    var ctx = await buildContext(drill, typeDef, opts, scenarios);
    var output = await generateScenarioContent(typeDef, ctx, llm);
    var parts = buildScenarioParts(typeDef, ctx, output);
    return addScenario(drillId, parts, 'CLAUDE', ctx.difficulty);
  }

  async function addManualScenario(drillId) {
    var drill = await getDrill(drillId);
    requireEditable(drill);
    var typeDef = getDrillType(drill.drillType);
    var catalog = typeDef.requiresCatalog ? await approvedCatalog() : [];
    var parts = buildScenarioParts(typeDef, { drill: drill, sections: [], catalog: catalog, difficulty: drill.config.difficulty }, null);
    return addScenario(drillId, parts, 'MANUAL', drill.config.difficulty);
  }

  async function regenerateScenario(drillId, scenarioId, opts) {
    opts = opts || {};
    var drill = await getDrill(drillId);
    requireEditable(drill);
    var typeDef = getDrillType(drill.drillType);
    var scenarios = await listScenarios(drillId);
    var current = scenarios.filter(function (s) { return s.scenarioId === scenarioId; })[0];
    if (!current || current.status === 'REMOVED') throw ServiceError('NOT_FOUND', 'Scenario ' + scenarioId + ' not found.');
    var ctx = await buildContext(drill, typeDef, {
      difficulty: opts.difficulty || current.difficulty, trainerHint: opts.trainerHint,
      category: current.category && typeDef.categories ? current.category : null, excludeScenarioId: scenarioId
    }, scenarios);
    var output = await generateScenarioContent(typeDef, ctx, llm);
    var parts = buildScenarioParts(typeDef, ctx, output);
    return withLock(drillId, async function () {
      var d = await getDrill(drillId);
      requireEditable(d);
      var s = await getScenario(drillId, scenarioId);
      s.history = (s.history || []).concat([{ version: s.version, replacedAt: now(), replacedBy: actor, trainee: s.trainee, trainer: s.trainer }]).slice(-3);
      s.version += 1;
      s.trainee = parts.trainee;
      s.trainer = parts.trainer;
      s.category = parts.category;
      s.difficulty = ctx.difficulty;
      s.generatedBy = 'CLAUDE';
      s.reviewFlags = parts.flags;
      recomputeContentFlags(s);
      markEdited(d, 'Scenario ' + scenarioId + ' regenerated');
      audit(d, 'SCENARIO_REGENERATED', { scenarioId: scenarioId, version: s.version });
      await saveScenario(s);
      await saveDrill(d);
      return s;
    });
  }

  var TRAINEE_PATCH_FIELDS = ['title', 'scenario', 'accountDetails', 'traineeInstructions'];
  var TRAINER_PATCH_FIELDS = ['correctAnswer', 'correctDecision', 'requiredAccountDetail', 'rationale', 'sources', 'commonMistakes', 'coachingNotes', 'trainerNotes', 'scoring'];

  async function updateScenario(drillId, scenarioId, patch) {
    patch = patch || {};
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      var s = await getScenario(drillId, scenarioId);
      if (s.status === 'REMOVED') throw ServiceError('NOT_FOUND', 'Scenario ' + scenarioId + ' was removed.');
      var traineeChanged = false;
      var trainerChanged = false;

      if (patch.trainee) {
        requireEditable(drill);
        TRAINEE_PATCH_FIELDS.forEach(function (f) {
          if (patch.trainee[f] !== undefined) { s.trainee[f] = deepClone(patch.trainee[f]); traineeChanged = true; }
        });
        if (patch.trainee.questions) {
          // Trainers edit wording, choices and "required"; question keys and types are fixed
          // by the drill type so scoring and response mapping stay valid.
          s.trainee.questions = s.trainee.questions.map(function (q) {
            var p = patch.trainee.questions.filter(function (x) { return x.key === q.key; })[0];
            if (!p) return q;
            var out = deepClone(q);
            if (p.prompt !== undefined) out.prompt = String(p.prompt);
            if (p.helpText !== undefined) out.helpText = String(p.helpText);
            if (p.required !== undefined) out.required = !!p.required;
            if (p.choices !== undefined && CHOICE_TYPES.indexOf(q.type) !== -1) out.choices = uniq(p.choices.map(String).map(function (c) { return c.trim(); }).filter(Boolean));
            return out;
          });
          traineeChanged = true;
        }
      }

      if (patch.trainer) {
        var sections = null;
        for (var i = 0; i < TRAINER_PATCH_FIELDS.length; i++) {
          var f = TRAINER_PATCH_FIELDS[i];
          if (patch.trainer[f] === undefined) continue;
          if (f === 'sources') {
            sections = sections || await getAllSections();
            s.trainer.sources = verifyTrainerSources(patch.trainer.sources, sections);
          } else if (f === 'scoring') {
            Object.keys(patch.trainer.scoring).forEach(function (k) {
              if (s.trainer.scoring[k] && patch.trainer.scoring[k].points != null) {
                s.trainer.scoring[k].points = Math.max(0, Number(patch.trainer.scoring[k].points) || 0);
              }
            });
          } else {
            s.trainer[f] = deepClone(patch.trainer[f]);
          }
          trainerChanged = true;
        }
      }

      if (!traineeChanged && !trainerChanged) return s;
      s.version += 1;
      recomputeContentFlags(s);
      if (traineeChanged) markEdited(drill, 'Scenario ' + scenarioId + ' edited');
      audit(drill, 'SCENARIO_EDITED', { scenarioId: scenarioId, trainee: traineeChanged, trainer: trainerChanged, version: s.version });
      await saveScenario(s);
      await saveDrill(drill);
      if (trainerChanged && hasForm(drill.status)) await rescoreDrillUnlocked(drill);
      return s;
    });
  }

  function verifyTrainerSources(list, sections) {
    return (list || []).map(function (src) {
      var v = verifyCitations([{ sectionId: src.sectionId, quote: src.quote }], sections)[0];
      return {
        sourceType: v.verified ? v.sourceType : (src.sourceType || 'TRAINER_ENTERED'),
        sectionId: v.sectionId, title: v.title || src.title || '', heading: v.heading || src.heading || '',
        url: v.url || src.url || '', quote: src.quote || '', supports: src.supports || '', verified: v.verified
      };
    });
  }

  async function removeScenario(drillId, scenarioId) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      requireEditable(drill);
      var s = await getScenario(drillId, scenarioId);
      s.status = 'REMOVED';
      markEdited(drill, 'Scenario ' + scenarioId + ' removed');
      audit(drill, 'SCENARIO_REMOVED', { scenarioId: scenarioId });
      await saveScenario(s);
      await saveDrill(drill);
      return s;
    });
  }

  async function resolveFlag(drillId, scenarioId, code, note) {
    if (isBlank(note)) throw ServiceError('NOTE_REQUIRED', 'Add a note saying how you checked this before resolving the flag.');
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      var s = await getScenario(drillId, scenarioId);
      var flag = (s.reviewFlags || []).filter(function (f) { return f.code === code && !f.resolved; })[0];
      if (!flag) throw ServiceError('NOT_FOUND', 'No open ' + code + ' flag on ' + scenarioId + '.');
      if (!flag.resolvable) throw ServiceError('NOT_RESOLVABLE', 'This flag clears automatically once the scenario is fixed.');
      flag.resolved = true;
      flag.resolvedBy = actor;
      flag.resolvedAt = now();
      flag.resolvedNote = String(note);
      audit(drill, 'FLAG_RESOLVED', { scenarioId: scenarioId, code: code, note: note });
      await saveScenario(s);
      await saveDrill(drill);
      return s;
    });
  }

  // ---- review & approval ---------------------------------------------------

  async function beginReview(drillId) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      if (drill.status === DrillStatus.GENERATED) {
        transitionDrill(drill, DrillStatus.TRAINER_REVIEW, actor, now());
        await saveDrill(drill);
      }
      return drill;
    });
  }

  function approvalProblems(scenarios) {
    var problems = [];
    var active = activeScenarios(scenarios);
    if (!active.length) problems.push('The drill has no scenarios.');
    active.forEach(function (s) {
      recomputeContentFlags(s);
      blockingFlags(s).forEach(function (f) { problems.push(s.scenarioId + ': ' + f.code + ' — ' + f.message); });
    });
    return problems;
  }

  async function approveDrill(drillId) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      if (drill.status === DrillStatus.GENERATED) transitionDrill(drill, DrillStatus.TRAINER_REVIEW, actor, now());
      if (drill.status !== DrillStatus.TRAINER_REVIEW) throw ServiceError('INVALID_TRANSITION', 'Only a drill in trainer review can be approved (current: ' + drill.status + ').');
      var scenarios = await listScenarios(drillId);
      var problems = approvalProblems(scenarios);
      if (problems.length) throw ServiceError('NOT_READY', 'Resolve these before approving: ' + problems.join(' | '), problems);
      var active = activeScenarios(scenarios);
      var warnings = [];
      if (active.length !== drill.config.scenarioCount) warnings.push('Drill has ' + active.length + ' scenarios; the configured count is ' + drill.config.scenarioCount + '.');
      transitionDrill(drill, DrillStatus.APPROVED, actor, now());
      drill.approval = {
        approvedBy: actor, approvedAt: now(), traineeHash: traineeContentHash(scenarios),
        scenarioIds: active.map(function (s) { return s.scenarioId; }), warnings: warnings
      };
      audit(drill, 'APPROVED', drill.approval);
      await saveDrill(drill);
      return drill;
    });
  }

  async function reopenForEdits(drillId) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      if (drill.status !== DrillStatus.APPROVED) throw ServiceError('INVALID_TRANSITION', 'Only an approved drill without a form can be reopened for edits.');
      markEdited(drill, 'Reopened for edits');
      await saveDrill(drill);
      return drill;
    });
  }

  // ---- Google Form (via the Form Bridge) ----------------------------------
  //
  // Idempotency:
  //  * The drill moves to FORM_CREATING (with the spec hash) BEFORE anything external
  //    happens, so a retry always knows a request may already exist.
  //  * The request file name carries drillId + specHash; the bridge looks it up by name
  //    before creating, so a retried request never produces a second request file.
  //  * The bridge keys forms by drillId (script property + Drive title search), so a
  //    duplicate request never produces a second form.
  //  * The dashboard only marks FORM_CREATED after reading the bridge's result file
  //    with the matching spec hash.

  async function createForm(drillId) {
    var settings = await requireFolder();
    return withLock('form__' + drillId, async function () {
      var drill = await getDrill(drillId);
      if (hasForm(drill.status) && drill.status !== DrillStatus.FORM_CREATING) {
        return { drill: drill, reused: true };
      }
      if (drill.status !== DrillStatus.APPROVED && drill.status !== DrillStatus.FORM_CREATING) {
        throw ServiceError('NOT_APPROVED', 'Approve the drill before creating its Google Form.');
      }
      var scenarios = await listScenarios(drillId);
      var typeDef = getDrillType(drill.drillType);
      if (!drill.approval || drill.approval.traineeHash !== traineeContentHash(scenarios)) {
        throw ServiceError('CHANGED_SINCE_APPROVAL', 'Trainee content changed after approval. Reopen, review and approve again.');
      }
      var approved = activeScenarios(scenarios).filter(function (s) { return drill.approval.scenarioIds.indexOf(s.scenarioId) !== -1; });
      var spec = buildFormSpec(drill, approved, typeDef, { collectVerifiedEmail: settings.collectVerifiedEmail !== false });

      if (drill.status === DrillStatus.APPROVED) {
        transitionDrill(drill, DrillStatus.FORM_CREATING, actor, now());
        drill.form = { state: 'REQUESTED', specHash: spec.specHash, requestedAt: now(), requestedBy: actor, requestFileId: null };
        audit(drill, 'FORM_REQUESTED', { specHash: spec.specHash });
        await saveDrill(drill);
      } else if (drill.form && drill.form.specHash !== spec.specHash) {
        throw ServiceError('SPEC_MISMATCH', 'The form spec no longer matches the original request. Contact an admin before retrying.');
      }

      var req = await bridge.requestForm(settings.bridgeFolderId, drillId, spec);
      drill.form.requestFileId = req.fileId;
      drill.form.requestReused = !!req.reused;
      await saveDrill(drill);
      return { drill: await refreshFormStatusUnlocked(drill, settings), reused: !!req.reused };
    });
  }

  async function refreshFormStatus(drillId) {
    var settings = await requireFolder();
    return withLock('form__' + drillId, async function () {
      return refreshFormStatusUnlocked(await getDrill(drillId), settings);
    });
  }

  async function refreshFormStatusUnlocked(drill, settings) {
    if (drill.status !== DrillStatus.FORM_CREATING) return drill;
    var result = await bridge.getFormResult(settings.bridgeFolderId, drill.drillId);
    if (!result || result.specHash !== drill.form.specHash) return drill;
    if (result.status === 'ERROR') {
      drill.form.lastError = result.error || 'Unknown bridge error';
      drill.form.lastErrorAt = result.processedAt || now();
      await saveDrill(drill);
      return drill;
    }
    if (result.status !== 'CREATED') return drill;
    drill.form = {
      state: 'CREATED', specHash: result.specHash, formId: result.formId, editUrl: result.editUrl,
      publishedUrl: result.publishedUrl, responseSheetId: result.responseSheetId || null,
      responseSheetUrl: result.responseSheetUrl || null,
      items: (result.items || []).map(function (it) {
        var sid = it.key.indexOf('/') !== -1 && it.key.charAt(0) !== '_' ? it.key.split('/')[0] : null;
        var qk = sid ? it.key.split('/')[1] : null;
        return { key: it.key, itemId: String(it.itemId), scenarioId: sid, questionKey: qk === '_section' ? null : qk };
      }),
      createdAt: result.processedAt || now(), requestFileId: drill.form.requestFileId,
      requestedAt: drill.form.requestedAt, requestedBy: drill.form.requestedBy
    };
    transitionDrill(drill, DrillStatus.FORM_CREATED, actor, now());
    audit(drill, 'FORM_CREATED', { formId: result.formId });
    await saveDrill(drill);
    return drill;
  }

  async function markSent(drillId, note) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      if (drill.status !== DrillStatus.FORM_CREATED) throw ServiceError('INVALID_TRANSITION', 'Only a drill whose form was just created can be marked as sent.');
      transitionDrill(drill, DrillStatus.SENT, actor, now());
      drill.sentAt = now();
      drill.sentNote = note || '';
      audit(drill, 'SENT', { note: note || '' });
      await saveDrill(drill);
      return drill;
    });
  }

  // ---- responses & scoring -------------------------------------------------

  async function syncResponses(drillId) {
    var settings = await requireFolder();
    var drill = await getDrill(drillId);
    if (!drill.form || drill.form.state !== 'CREATED') throw ServiceError('NO_FORM', 'This drill has no Google Form yet.');
    var payload = await bridge.getResponses(settings.bridgeFolderId, drillId);
    if (!payload) return { status: 'NO_EXPORT_YET', drill: drill };
    if (payload.formId !== drill.form.formId) {
      throw ServiceError('FORM_MISMATCH', 'The response export belongs to a different form (' + payload.formId + '). Nothing was imported.');
    }
    return withLock(drillId, async function () {
      drill = await getDrill(drillId);
      var scenarios = await listScenarios(drillId);
      var byScenario = {};
      scenarios.forEach(function (s) { byScenario[s.scenarioId] = s; });
      var raw = payload.source === 'SHEET' && payload.sheet
        ? rawResponsesFromSheet(payload.sheet.headers || [], payload.sheet.rows || [])
        : (payload.responses || []);
      var mapped = mapResponses(drillId, raw, drill.form.items || [], questionKeysByScenario(scenarios));
      var rowsByResponse = {};
      mapped.rows.forEach(function (r) { (rowsByResponse[r.responseId] = rowsByResponse[r.responseId] || []).push(r); });

      var created = 0, updated = 0;
      for (var i = 0; i < mapped.responses.length; i++) {
        var meta = mapped.responses[i];
        var docId = responseDocId(drillId, meta.responseId);
        var existing = await store.get(COLLECTIONS.responses, docId);
        var answers = {};
        (rowsByResponse[meta.responseId] || []).forEach(function (row) {
          var k = row.scenarioId + '/' + row.questionKey;
          var scenario = byScenario[row.scenarioId];
          var prev = existing && existing.answers && existing.answers[k];
          answers[k] = {
            answerId: row.answerId, scenarioId: row.scenarioId, questionKey: row.questionKey,
            answer: row.answer, answerHash: row.answerHash,
            score: scenario ? scoreAnswerRow(row, scenario, prev && prev.score) : null
          };
        });
        var doc = {
          responseKey: docId, drillId: drillId, responseId: meta.responseId, formId: payload.formId,
          traineeId: meta.traineeId, traineeName: meta.traineeName, traineeEmail: meta.traineeEmail,
          submittedAt: meta.submittedAt, answers: answers, importedAt: existing ? existing.importedAt : now(), updatedAt: now()
        };
        doc.summary = summarizeScores(Object.keys(answers).map(function (k) { return answers[k].score; }).filter(Boolean));
        if (existing && hashObject([existing.answers, existing.traineeId]) === hashObject([doc.answers, doc.traineeId])) continue;
        await store.put(COLLECTIONS.responses, docId, doc);
        if (existing) updated++; else created++;
      }

      var all = await store.list(COLLECTIONS.responses, ['drillId', drillId]);
      drill.responseStats = statsFor(all, mapped, payload);
      if (all.length && (drill.status === DrillStatus.FORM_CREATED || drill.status === DrillStatus.SENT)) {
        transitionDrill(drill, DrillStatus.RESPONSES_RECEIVED, actor, now());
      }
      audit(drill, 'RESPONSES_SYNCED', { created: created, updated: updated, unmapped: mapped.unmapped.length });
      await saveDrill(drill);
      return { status: 'OK', created: created, updated: updated, unmapped: mapped.unmapped, drill: drill };
    });
  }

  function statsFor(responses, mapped, payload) {
    var pending = 0;
    responses.forEach(function (r) { pending += (r.summary && r.summary.pendingReview) || 0; });
    return {
      responses: responses.length,
      trainees: uniq(responses.map(function (r) { return r.traineeId; })).length,
      pendingReview: pending,
      unmapped: mapped ? mapped.unmapped.length : 0,
      lastSyncAt: now(),
      exportGeneratedAt: payload ? payload.generatedAt : null,
      exportSource: payload ? payload.source : null
    };
  }

  async function scoreAnswer(drillId, responseKey, answerKey, input) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      if ([DrillStatus.RESPONSES_RECEIVED, DrillStatus.UNDER_REVIEW].indexOf(drill.status) === -1) {
        throw ServiceError('INVALID_TRANSITION', 'Scores can be changed while responses are under review (current: ' + drill.status + '). Reopen review first.');
      }
      var resp = await store.get(COLLECTIONS.responses, responseKey);
      if (!resp || resp.drillId !== drillId || !resp.answers[answerKey] || !resp.answers[answerKey].score) {
        throw ServiceError('NOT_FOUND', 'Answer not found.');
      }
      applyTrainerScore(resp.answers[answerKey].score, input || {}, actor, now());
      resp.summary = summarizeScores(Object.keys(resp.answers).map(function (k) { return resp.answers[k].score; }).filter(Boolean));
      resp.updatedAt = now();
      await store.put(COLLECTIONS.responses, responseKey, resp);
      if (drill.status === DrillStatus.RESPONSES_RECEIVED) transitionDrill(drill, DrillStatus.UNDER_REVIEW, actor, now());
      drill.responseStats = statsFor(await store.list(COLLECTIONS.responses, ['drillId', drillId]), null, null);
      await saveDrill(drill);
      return resp;
    });
  }

  async function acceptAutoScores(drillId) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      if ([DrillStatus.RESPONSES_RECEIVED, DrillStatus.UNDER_REVIEW].indexOf(drill.status) === -1) {
        throw ServiceError('INVALID_TRANSITION', 'No responses are under review.');
      }
      var responses = await store.list(COLLECTIONS.responses, ['drillId', drillId]);
      var accepted = 0;
      for (var i = 0; i < responses.length; i++) {
        var r = responses[i];
        var changed = false;
        Object.keys(r.answers).forEach(function (k) {
          var sc = r.answers[k].score;
          if (sc && sc.mode === 'AUTO' && sc.finalScore == null) {
            applyTrainerScore(sc, { finalScore: sc.autoScore }, actor, now());
            sc.acceptedFromAuto = true;
            changed = true;
            accepted++;
          }
        });
        if (changed) {
          r.summary = summarizeScores(Object.keys(r.answers).map(function (k) { return r.answers[k].score; }).filter(Boolean));
          await store.put(COLLECTIONS.responses, r.responseKey, r);
        }
      }
      if (drill.status === DrillStatus.RESPONSES_RECEIVED) transitionDrill(drill, DrillStatus.UNDER_REVIEW, actor, now());
      drill.responseStats = statsFor(await store.list(COLLECTIONS.responses, ['drillId', drillId]), null, null);
      audit(drill, 'AUTO_SCORES_ACCEPTED', { count: accepted });
      await saveDrill(drill);
      return { accepted: accepted };
    });
  }

  // After an answer-key correction: recompute auto scores; trainer scores are kept but
  // flagged for another look when the expected answer changed.
  async function rescoreDrillUnlocked(drill) {
    var scenarios = await listScenarios(drill.drillId);
    var byScenario = {};
    scenarios.forEach(function (s) { byScenario[s.scenarioId] = s; });
    var responses = await store.list(COLLECTIONS.responses, ['drillId', drill.drillId]);
    for (var i = 0; i < responses.length; i++) {
      var r = responses[i];
      Object.keys(r.answers).forEach(function (k) {
        var a = r.answers[k];
        var s = byScenario[a.scenarioId];
        if (!s) return;
        a.score = scoreAnswerRow({ answerId: a.answerId, drillId: r.drillId, scenarioId: a.scenarioId, questionKey: a.questionKey, traineeId: r.traineeId, answer: a.answer, answerHash: a.answerHash }, s, a.score);
      });
      r.summary = summarizeScores(Object.keys(r.answers).map(function (k) { return r.answers[k].score; }).filter(Boolean));
      await store.put(COLLECTIONS.responses, r.responseKey, r);
    }
    drill.responseStats = statsFor(responses, null, null);
    await saveDrill(drill);
  }

  async function completeDrill(drillId, force) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      var responses = await store.list(COLLECTIONS.responses, ['drillId', drillId]);
      var pending = 0;
      responses.forEach(function (r) {
        Object.keys(r.answers).forEach(function (k) {
          var sc = r.answers[k].score;
          if (sc && (sc.reviewStatus === 'NEEDS_REVIEW' || (sc.mode === 'MANUAL' && sc.finalScore == null && sc.maxPoints > 0))) pending++;
        });
      });
      if (pending && !force) throw ServiceError('PENDING_REVIEW', pending + ' answer(s) still need a trainer score.');
      transitionDrill(drill, DrillStatus.COMPLETED, actor, now());
      audit(drill, 'COMPLETED', { pendingAtCompletion: pending });
      await saveDrill(drill);
      return drill;
    });
  }

  async function reopenReview(drillId) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      transitionDrill(drill, DrillStatus.UNDER_REVIEW, actor, now());
      audit(drill, 'REVIEW_REOPENED');
      await saveDrill(drill);
      return drill;
    });
  }

  // Removes the drill, its scenarios and its imported responses from the dashboard.
  // A Google Form that was already created stays in Drive (the bridge folder).
  async function deleteDrill(drillId) {
    return withLock(drillId, async function () {
      var drill = await getDrill(drillId);
      var scenarios = await store.list(COLLECTIONS.scenarios, ['drillId', drillId]);
      var responses = await store.list(COLLECTIONS.responses, ['drillId', drillId]);
      for (var i = 0; i < responses.length; i++) await store.remove(COLLECTIONS.responses, responses[i].responseKey);
      for (var j = 0; j < scenarios.length; j++) await store.remove(COLLECTIONS.scenarios, scenarioDocId(drillId, scenarios[j].scenarioId));
      await store.put(COLLECTIONS.deletedDrills, drillId, { drillId: drillId, drillDate: drill.drillDate, formId: drill.form && drill.form.formId || null, deletedAt: now(), deletedBy: actor });
      await store.remove(COLLECTIONS.drills, drillId);
      return { drillId: drillId, scenarios: scenarios.length, responses: responses.length, formId: drill.form && drill.form.formId || null };
    });
  }

  async function coachingReport(filter) {
    filter = filter || {};
    var drills = await store.list(COLLECTIONS.drills);
    if (filter.drillType) drills = drills.filter(function (d) { return d.drillType === filter.drillType; });
    if (filter.since) drills = drills.filter(function (d) { return d.drillDate >= filter.since; });
    var ids = {};
    drills.forEach(function (d) { ids[d.drillId] = true; });
    var responses = (await store.list(COLLECTIONS.responses)).filter(function (r) { return ids[r.drillId]; });
    var answers = [], scores = [];
    responses.forEach(function (r) {
      Object.keys(r.answers).forEach(function (k) {
        var a = r.answers[k];
        answers.push({ answerId: a.answerId, traineeName: r.traineeName, traineeEmail: r.traineeEmail });
        if (a.score) scores.push(a.score);
      });
    });
    return buildCoachingReport(drills, answers, scores);
  }

  // ---- sources (Knowledge Library + CSQ Slack), triage catalog -------------

  async function requestSourceRefresh() {
    var settings = await requireFolder();
    return bridge.requestSourceExport(settings.bridgeFolderId, settings.sourceDocId, now().replace(/[^0-9A-Za-z]/g, ''));
  }

  async function importSources() {
    var settings = await requireFolder();
    var exp = await bridge.getSourceExport(settings.bridgeFolderId);
    if (!exp || !exp.sections) {
      var bridgeStatus = bridge.getBridgeStatus ? await bridge.getBridgeStatus(settings.bridgeFolderId) : null;
      return { status: 'NO_EXPORT_YET', bridge: bridgeStatus };
    }
    var sections = exp.sections.filter(function (s) { return !isBlank(s.text) && !isBlank(s.sectionId); });
    if (!sections.length) throw ServiceError('EMPTY_SOURCE', 'The source export contained no text sections. Nothing was replaced.');
    var chunks = [];
    var current = [], size = 0;
    sections.forEach(function (s) {
      var len = JSON.stringify(s).length;
      if (size + len > SOURCE_CHUNK_CHARS && current.length) { chunks.push(current); current = []; size = 0; }
      current.push(s);
      size += len;
    });
    if (current.length) chunks.push(current);
    var oldChunks = await store.list(COLLECTIONS.sources);
    for (var i = 0; i < chunks.length; i++) {
      var id = 'kl-' + pad3(i);
      await store.put(COLLECTIONS.sources, id, { chunkId: id, generatedAt: exp.generatedAt, docId: exp.docId, sections: chunks[i] });
    }
    for (var j = 0; j < oldChunks.length; j++) {
      var cid = oldChunks[j].chunkId || '';
      if (cid.indexOf('kl-') === 0 && parseInt(cid.slice(3), 10) >= chunks.length) await store.remove(COLLECTIONS.sources, cid);
    }
    var s2 = await getSettings();
    s2.sourcesMeta = { generatedAt: exp.generatedAt, importedAt: now(), importedBy: actor, sections: sections.length, chunks: chunks.length, docId: exp.docId };
    await store.put(COLLECTIONS.settings, 'main', s2);
    return { status: 'OK', sections: sections.length, generatedAt: exp.generatedAt };
  }

  // Automatic source refresh: imports a newer Library export, asks the bridge for a
  // new export when the Library doc changed, and re-pulls CSQ Slack channels that are
  // older than SLACK_STALE_MS. Safe to call on every page load.
  async function refreshSources(opts) {
    opts = opts || {};
    var settings = await getSettings();
    var result = { library: null, slack: [] };
    if (isBlank(settings.bridgeFolderId)) {
      result.library = { status: 'NOT_CONFIGURED' };
    } else {
      try {
        var meta = settings.sourcesMeta || null;
        var index = bridge.getSourceIndex ? await bridge.getSourceIndex(settings.bridgeFolderId) : null;
        if (index && (!meta || index.generatedAt > meta.generatedAt)) {
          result.library = await importSources();
        } else {
          var docModified = bridge.getDocModifiedTime ? await bridge.getDocModifiedTime(settings.sourceDocId) : null;
          var stale = !index || (docModified && docModified > index.generatedAt);
          if (stale || opts.force) {
            var key = (opts.force ? now() : (docModified || clock.today())).replace(/[^0-9A-Za-z]/g, '');
            await bridge.requestSourceExport(settings.bridgeFolderId, settings.sourceDocId, key);
            result.library = { status: 'REQUESTED' };
          } else {
            result.library = { status: 'CURRENT', generatedAt: index.generatedAt };
          }
        }
      } catch (e) {
        result.library = { status: 'ERROR', message: e.message || String(e) };
      }
    }
    if (deps.slack) {
      var channels = csqChannels(settings);
      for (var i = 0; i < channels.length; i++) {
        var ch = channels[i];
        var existing = await store.get(COLLECTIONS.sources, 'slack-' + ch.id);
        var age = existing ? Date.parse(now()) - Date.parse(existing.pulledAt) : Infinity;
        var usable = existing && existing.parserVersion === SLACK_PARSER_VERSION && (existing.sections || []).length > 0;
        if (!opts.force && usable && age < SLACK_STALE_MS) { result.slack.push({ channel: ch.name, status: 'CURRENT', messages: existing.sections.length }); continue; }
        try {
          var msgs = await deps.slack.readChannel(ch.id, { days: SLACK_DAYS });
          var sections = slackSections(msgs, ch);
          var kept = [], size = 0;
          for (var k = 0; k < sections.length && size < SOURCE_CHUNK_CHARS; k++) { kept.push(sections[k]); size += JSON.stringify(sections[k]).length; }
          await store.put(COLLECTIONS.sources, 'slack-' + ch.id, { chunkId: 'slack-' + ch.id, kind: 'SLACK', channelId: ch.id, channelName: ch.name, pulledAt: now(), parserVersion: SLACK_PARSER_VERSION, sections: kept });
          result.slack.push({ channel: ch.name, status: 'PULLED', messages: kept.length });
        } catch (e) {
          result.slack.push({ channel: ch.name, status: 'ERROR', message: e.message || String(e) });
        }
      }
    }
    return result;
  }

  async function sourceSummary() {
    var settings = await getSettings();
    var chunks = await store.list(COLLECTIONS.sources);
    var slack = chunks.filter(function (c) { return c.kind === 'SLACK'; }).map(function (c) {
      return { channelId: c.channelId, channel: c.channelName, messages: (c.sections || []).length, pulledAt: c.pulledAt };
    });
    return { library: settings.sourcesMeta || null, slack: slack, channels: csqChannels(settings) };
  }

  // Triage answer choices come from documented processes. Entries backed by a quote that
  // is really in the sources are used automatically; unbacked ones are dropped.
  async function ensureCatalog() {
    var approved = await approvedCatalog();
    // Entries saved before short process names were introduced are rebuilt once.
    var current = approved.filter(function (e) { return e.nameVersion === PROCESS_NAME_VERSION; });
    if (current.length >= 2 && current.length === approved.length) return approved;
    await proposeCatalog();
    approved = await approvedCatalog();
    if (approved.length < 2) {
      throw ServiceError('CATALOG_REQUIRED', 'Could not find at least two documented triage processes in the sources. Refresh sources and try again.');
    }
    return approved;
  }

  async function proposeCatalog() {
    var sections = selectSections(await getAllSections(), TRIAGE_TYPE.sourceKeywords, SOURCE_PROMPT_CHARS);
    var entries = await proposeCatalogEntries(TRIAGE_TYPE, sections, llm);
    var saved = [];
    var keepIds = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var id = 'PROC-' + hashString(normalizeText(e.name)).slice(0, 6).toUpperCase();
      if (keepIds[id]) continue;
      keepIds[id] = true;
      var verified = (e.sources || []).some(function (x) { return x.verified; });
      var doc = Object.assign({ catalogId: id, proposedAt: now(), proposedBy: actor }, e, {
        status: verified ? 'APPROVED' : 'REJECTED', approvedBy: verified ? 'auto (verified quote)' : null,
        nameVersion: PROCESS_NAME_VERSION
      });
      await store.put(COLLECTIONS.catalog, id, doc);
      saved.push(doc);
    }
    // A rebuild replaces the catalog: entries the new pass did not return stop being choices.
    if (saved.some(function (d) { return d.status === 'APPROVED'; })) {
      var all = await store.list(COLLECTIONS.catalog);
      for (var j = 0; j < all.length; j++) {
        if (!keepIds[all[j].catalogId] && all[j].status === 'APPROVED') {
          all[j].status = 'REPLACED';
          all[j].replacedAt = now();
          await store.put(COLLECTIONS.catalog, all[j].catalogId, all[j]);
        }
      }
    }
    return saved;
  }

  async function updateCatalogEntry(catalogId, patch) {
    var doc = await store.get(COLLECTIONS.catalog, catalogId);
    if (!doc) throw ServiceError('NOT_FOUND', 'Catalog entry not found.');
    ['name', 'tag', 'checklist', 'category', 'whenToUse'].forEach(function (f) {
      if (patch[f] !== undefined) doc[f] = String(patch[f]);
    });
    if (patch.status) {
      if (patch.status === 'APPROVED') {
        var verified = (doc.sources || []).some(function (s) { return s.verified; });
        if (!verified && isBlank(patch.note)) {
          throw ServiceError('NOTE_REQUIRED', 'No verified source quote backs this entry. Add a note saying where you confirmed it.');
        }
        doc.approvedBy = actor;
        doc.approvedAt = now();
        doc.approvalNote = patch.note || '';
      }
      doc.status = patch.status;
    }
    doc.updatedAt = now();
    await store.put(COLLECTIONS.catalog, catalogId, doc);
    return doc;
  }

  async function saveSettings(patch) {
    var s = await getSettings();
    ['bridgeFolderId', 'sourceDocId'].forEach(function (f) {
      if (patch[f] !== undefined) s[f] = String(patch[f]).trim();
    });
    if (patch.collectVerifiedEmail !== undefined) s.collectVerifiedEmail = !!patch.collectVerifiedEmail;
    if (patch.csqChannels !== undefined) s.csqChannels = patch.csqChannels;
    s.updatedAt = now();
    s.updatedBy = actor;
    await store.put(COLLECTIONS.settings, 'main', s);
    return s;
  }

  return {
    getSettings: getSettings, saveSettings: saveSettings,
    createDrill: createDrill, listDrills: listDrills, getDrillBundle: getDrillBundle, deleteDrill: deleteDrill,
    generateNextScenario: generateNextScenario, addManualScenario: addManualScenario,
    regenerateScenario: regenerateScenario, updateScenario: updateScenario, removeScenario: removeScenario,
    resolveFlag: resolveFlag, beginReview: beginReview, approveDrill: approveDrill, reopenForEdits: reopenForEdits,
    createForm: createForm, refreshFormStatus: refreshFormStatus, markSent: markSent,
    syncResponses: syncResponses, scoreAnswer: scoreAnswer, acceptAutoScores: acceptAutoScores,
    completeDrill: completeDrill, reopenReview: reopenReview, coachingReport: coachingReport,
    requestSourceRefresh: requestSourceRefresh, importSources: importSources, getAllSections: getAllSections,
    refreshSources: refreshSources, sourceSummary: sourceSummary,
    proposeCatalog: proposeCatalog, updateCatalogEntry: updateCatalogEntry,
    listCatalog: function () { return store.list(COLLECTIONS.catalog); }
  };
}
