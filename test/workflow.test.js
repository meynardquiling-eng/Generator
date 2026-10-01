const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./helpers/loadCore');
const plain = v => JSON.parse(JSON.stringify(v));
const { MemoryStore, FakeBridge, FakeLlm, FakeClock, seedSources } = require('./helpers/fakes');

async function setup(opts = {}) {
  const core = loadCore();
  const store = new MemoryStore();
  const bridge = new FakeBridge();
  const llm = new FakeLlm();
  const clock = new FakeClock();
  await seedSources(store, opts.sections);
  const svc = (actor = 'trainer-1') => core.createDrillService({ store, bridge, llm, clock, actor, sleepMs: 1 });
  return { core, store, bridge, llm, clock, svc: svc(), makeSvc: svc };
}

async function generatedApprovedDrill(env, count = 5) {
  const drill = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  for (let i = 0; i < count; i++) await env.svc.generateNextScenario(drill.drillId);
  await env.svc.beginReview(drill.drillId);
  await env.svc.approveDrill(drill.drillId);
  return drill.drillId;
}

function allFormText(spec) {
  return JSON.stringify([spec.title, spec.description, spec.items]);
}

test('end to end: create, generate, review, approve, form, two trainees, sync, score, complete', async () => {
  const env = await setup();
  const { svc, bridge } = env;

  const drill = await svc.createDrill({ drillType: 'APPROVE_DENY' });
  assert.equal(drill.drillId, 'APPROVE-DENY-2026-10-01-001');
  assert.equal(drill.status, 'DRAFT');
  assert.equal(drill.config.scenarioCount, 5);
  assert.equal(drill.config.targetMinutes, 15);

  for (let i = 0; i < 5; i++) await svc.generateNextScenario(drill.drillId);
  let bundle = await svc.getDrillBundle(drill.drillId);
  assert.deepEqual(plain(bundle.scenarios.map(s => s.scenarioId)), ['AD-001', 'AD-002', 'AD-003', 'AD-004', 'AD-005']);
  assert.equal(bundle.drill.status, 'GENERATED', 'generated is not approved');
  for (const s of bundle.scenarios) {
    assert.deepEqual(plain(s.trainer.correctAnswer.action), ['Free month']);
    assert.ok(s.trainer.sources.some(src => src.verified), 'answer key traced to a verified source');
    assert.equal(s.reviewFlags.filter(f => f.blocking && !f.resolved).length, 0, JSON.stringify(s.reviewFlags));
  }

  await svc.beginReview(drill.drillId);
  await svc.approveDrill(drill.drillId);

  const { drill: requested } = await svc.createForm(drill.drillId);
  assert.equal(requested.status, 'FORM_CREATING');
  const reqFile = Object.values(bridge.files).find(f => f.content.kind === 'FORM_REQUEST');
  const spec = reqFile.content.spec;

  // Trainee-safe: no answer key, rationale, coaching notes or source quotes in the form.
  const text = allFormText(spec);
  bundle = await svc.getDrillBundle(drill.drillId);
  for (const s of bundle.scenarios) {
    assert.ok(!text.includes(s.trainer.rationale));
    assert.ok(!text.includes(s.trainer.coachingNotes));
    s.trainer.commonMistakes.forEach(m => assert.ok(!text.includes(m)));
    s.trainer.sources.forEach(src => assert.ok(!text.includes(src.quote)));
    assert.ok(text.includes(s.trainee.scenario));
  }
  assert.ok(spec.description.includes('Drill ID: ' + drill.drillId));
  assert.equal(spec.items.filter(i => i.kind === 'SECTION').length, 5);
  assert.equal(spec.items.filter(i => i.kind === 'QUESTION').length, 1 + 5 * 3);
  assert.equal(spec.settings.isQuiz, false);
  assert.equal(spec.settings.publishSummary, false);

  bridge.run();
  const created = await svc.refreshFormStatus(drill.drillId);
  assert.equal(created.status, 'FORM_CREATED');
  assert.equal(created.form.formId, 'form-1');
  await svc.markSent(drill.drillId, 'Posted in cohort channel');

  // Two trainees submit the same form.
  bridge.submit(drill.drillId, { email: 'ana@example.com', name: 'Ana', answers: {
    'AD-001/action': ['Free month'], 'AD-001/accountDetail': 'Completed cleanings: 3', 'AD-001/explanation': 'Has 3 cleanings',
    'AD-002/action': ['ETF waiver'], 'AD-002/accountDetail': 'No-show', 'AD-002/explanation': 'No-show'
  } });
  bridge.submit(drill.drillId, { email: 'ben@example.com', name: 'Ben', answers: {
    'AD-001/action': ['Free month', 'ETF waiver'], 'AD-001/accountDetail': 'cleanings', 'AD-001/explanation': '...'
  } });

  const sync = await svc.syncResponses(drill.drillId);
  assert.equal(sync.created, 2);
  assert.equal(sync.unmapped.length, 0);
  bundle = await svc.getDrillBundle(drill.drillId);
  assert.equal(bundle.drill.status, 'RESPONSES_RECEIVED');
  assert.equal(bundle.drill.responseStats.trainees, 2);

  const ana = bundle.responses.find(r => r.traineeEmail === 'ana@example.com');
  const ben = bundle.responses.find(r => r.traineeEmail === 'ben@example.com');
  assert.equal(ana.traineeName, 'Ana');
  assert.equal(ana.answers['AD-001/action'].score.autoScore, 2);
  assert.equal(ana.answers['AD-002/action'].score.autoScore, 0);
  assert.equal(ana.answers['AD-002/action'].score.autoGapTag, 'INCORRECT_DECISION');
  assert.equal(ben.answers['AD-001/action'].score.autoCorrect, false, 'extra action makes the set wrong');
  // Subjective answers wait for a trainer.
  const sub = ana.answers['AD-001/explanation'].score;
  assert.equal(sub.mode, 'MANUAL');
  assert.equal(sub.autoScore, null);
  assert.equal(sub.reviewStatus, 'NEEDS_REVIEW');

  // Trainer scores the subjective answer and overrides an auto score; both stored separately.
  await svc.scoreAnswer(drill.drillId, ana.responseKey, 'AD-001/explanation', { finalScore: 1, gapTags: ['WEAK_REASONING'], coachingNote: 'Name the policy.' });
  await svc.scoreAnswer(drill.drillId, ana.responseKey, 'AD-002/action', { finalScore: 1 });
  bundle = await svc.getDrillBundle(drill.drillId);
  const ana2 = bundle.responses.find(r => r.traineeEmail === 'ana@example.com');
  assert.equal(ana2.answers['AD-002/action'].score.autoScore, 0);
  assert.equal(ana2.answers['AD-002/action'].score.finalScore, 1);
  assert.equal(ana2.answers['AD-001/explanation'].score.coachingNote, 'Name the policy.');
  assert.equal(bundle.drill.status, 'UNDER_REVIEW');

  await assert.rejects(svc.completeDrill(drill.drillId), /still need a trainer score/);
  await svc.acceptAutoScores(drill.drillId);
  const done = await svc.completeDrill(drill.drillId, true);
  assert.equal(done.status, 'COMPLETED');

  const report = await svc.coachingReport();
  assert.equal(report.trainees.length, 2);
  assert.ok(report.gaps.find(g => g.tag === 'WEAK_REASONING'));
  assert.ok(report.commonWrongAnswers.find(w => w.expected === 'Free month' && w.given.includes('ETF waiver')));
});

test('scenario answer key is never modified by response sync', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 2);
  await env.svc.createForm(drillId);
  env.bridge.run();
  await env.svc.refreshFormStatus(drillId);
  const before = JSON.stringify((await env.svc.getDrillBundle(drillId)).scenarios);
  env.bridge.submit(drillId, { email: 'a@x.com', name: 'A', answers: { 'AD-001/action': ['None of the above'] } });
  await env.svc.syncResponses(drillId);
  await env.svc.syncResponses(drillId);
  const after = JSON.stringify((await env.svc.getDrillBundle(drillId)).scenarios);
  assert.equal(after, before);
});

test('reopening an existing drill from a fresh dashboard session shows everything', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 3);
  const other = env.makeSvc('trainer-2');
  const list = await other.listDrills();
  assert.equal(list[0].drillId, drillId);
  assert.equal(list[0].status, 'APPROVED');
  const bundle = await other.getDrillBundle(drillId);
  assert.equal(bundle.scenarios.length, 3);
  assert.ok(bundle.scenarios[0].trainer.rationale.length > 0);
});

test('drill IDs are unique per type and day', async () => {
  const env = await setup();
  const a = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  const b = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  assert.equal(a.drillId, 'APPROVE-DENY-2026-10-01-001');
  assert.equal(b.drillId, 'APPROVE-DENY-2026-10-01-002');
});

test('regenerating a scenario keeps its ID, bumps the version and withdraws approval', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 2);
  const before = (await env.svc.getDrillBundle(drillId)).scenarios[1];
  const s = await env.svc.regenerateScenario(drillId, 'AD-002', { trainerHint: 'make it about a pause' });
  assert.equal(s.scenarioId, 'AD-002');
  assert.equal(s.version, before.version + 1);
  assert.notEqual(s.trainee.scenario, before.trainee.scenario);
  assert.equal(s.history.length, 1);
  const d = (await env.svc.getDrillBundle(drillId)).drill;
  assert.equal(d.status, 'TRAINER_REVIEW');
  assert.equal(d.approval, null);
  await assert.rejects(env.svc.createForm(drillId), /Approve the drill/);
});

test('removed scenario IDs are never reused', async () => {
  const env = await setup();
  const d = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  await env.svc.generateNextScenario(d.drillId);
  await env.svc.generateNextScenario(d.drillId);
  await env.svc.removeScenario(d.drillId, 'AD-002');
  const s = await env.svc.generateNextScenario(d.drillId);
  assert.equal(s.scenarioId, 'AD-003');
});

test('editing before approval works; after form creation only the answer key can change, and it rescores', async () => {
  const env = await setup();
  const d = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  await env.svc.generateNextScenario(d.drillId);
  const edited = await env.svc.updateScenario(d.drillId, 'AD-001', {
    trainee: { scenario: 'Edited ticket text from the trainer.', questions: [{ key: 'explanation', prompt: 'Explain in one sentence.' }] },
    trainer: { trainerNotes: 'Use with week-2 cohort.' }
  });
  assert.equal(edited.trainee.scenario, 'Edited ticket text from the trainer.');
  assert.equal(edited.trainee.questions.find(q => q.key === 'explanation').prompt, 'Explain in one sentence.');
  assert.equal(edited.trainee.questions.find(q => q.key === 'explanation').type, 'PARAGRAPH', 'type stays fixed');
  await env.svc.approveDrill(d.drillId);
  await env.svc.createForm(d.drillId);
  env.bridge.run();
  await env.svc.refreshFormStatus(d.drillId);
  const spec = Object.values(env.bridge.files).find(f => f.content.kind === 'FORM_REQUEST').content.spec;
  assert.ok(allFormText(spec).includes('Edited ticket text from the trainer.'), 'approved edit is what reaches the form');

  await assert.rejects(env.svc.updateScenario(d.drillId, 'AD-001', { trainee: { scenario: 'late change' } }), /locked/i);

  env.bridge.submit(d.drillId, { email: 't@x.com', name: 'T', answers: { 'AD-001/action': ['ETF waiver'] } });
  await env.svc.syncResponses(d.drillId);
  let r = (await env.svc.getDrillBundle(d.drillId)).responses[0];
  assert.equal(r.answers['AD-001/action'].score.autoScore, 0);
  // Trainer corrects the answer key; the auto score follows.
  await env.svc.updateScenario(d.drillId, 'AD-001', { trainer: { correctAnswer: { action: ['ETF waiver'], accountDetail: 'No-show' } } });
  r = (await env.svc.getDrillBundle(d.drillId)).responses[0];
  assert.equal(r.answers['AD-001/action'].score.autoScore, 2);
});

test('createForm retried after the dashboard write failed does not create a second request or form', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 2);
  // The bridge request succeeds, then saving requestFileId on the drill fails.
  env.store.failNext('put', 'drills', d => d.form && d.form.requestFileId);
  await assert.rejects(env.svc.createForm(drillId), /simulated put failure/);
  assert.equal(env.bridge.requestFilesCreated, 1);
  const mid = (await env.svc.getDrillBundle(drillId)).drill;
  assert.equal(mid.status, 'FORM_CREATING', 'status recorded before the external call');

  const retry = await env.svc.createForm(drillId);
  assert.equal(retry.reused, true);
  assert.equal(env.bridge.requestFilesCreated, 1);
  env.bridge.run();
  env.bridge.run();
  await env.svc.refreshFormStatus(drillId);
  assert.equal(env.bridge.formsCreated, 1);

  // A further retry after success reuses the form.
  const again = await env.svc.createForm(drillId);
  assert.equal(again.reused, true);
  assert.equal(env.bridge.formsCreated, 1);
});

test('form created on the Google side but the result write failed: next bridge run reuses the form', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 2);
  await env.svc.createForm(drillId);
  env.bridge.failNextFormCreateAfterItems = 1;
  env.bridge.run();
  const d1 = await env.svc.refreshFormStatus(drillId);
  assert.equal(d1.status, 'FORM_CREATING');
  assert.match(d1.form.lastError, /simulated/);
  env.bridge.run();
  const d2 = await env.svc.refreshFormStatus(drillId);
  assert.equal(d2.status, 'FORM_CREATED');
  assert.equal(env.bridge.formsCreated, 1);
  const form = env.bridge.forms[drillId];
  const keys = form.items.map(i => i.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate items');
});

test('trainee content changed after approval blocks form creation', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 1);
  // Simulate an out-of-band write that bypassed the service.
  const s = await env.store.get('scenarios', drillId + '__AD-001');
  s.trainee.scenario = 'tampered';
  await env.store.put('scenarios', drillId + '__AD-001', s);
  await assert.rejects(env.svc.createForm(drillId), /changed after approval/);
  assert.equal(env.bridge.requestFilesCreated, 0);
});

test('missing source material: generation refuses instead of inventing policy', async () => {
  const env = await setup({ sections: [] });
  const d = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  await assert.rejects(env.svc.generateNextScenario(d.drillId), /No approved source sections/);
  assert.equal(env.llm.calls, 0);
});

test('generator says sources are insufficient: scenario is flagged and approval is blocked until a trainer resolves it', async () => {
  const env = await setup();
  const d = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  env.llm.queue(out => Object.assign(out, { insufficientSource: true, insufficientReason: 'No rule for paused memberships.' }));
  const s = await env.svc.generateNextScenario(d.drillId);
  assert.ok(s.reviewFlags.find(f => f.code === 'INSUFFICIENT_SOURCE' && f.blocking));
  await assert.rejects(env.svc.approveDrill(d.drillId), /INSUFFICIENT_SOURCE/);
  await assert.rejects(env.svc.resolveFlag(d.drillId, 'AD-001', 'INSUFFICIENT_SOURCE', ''), /Add a note/);
  await env.svc.resolveFlag(d.drillId, 'AD-001', 'INSUFFICIENT_SOURCE', 'Confirmed with CSQ lead in #csq-customer-care-control.');
  const ok = await env.svc.approveDrill(d.drillId);
  assert.equal(ok.status, 'APPROVED');
});

test('a cited quote that is not in the sources is flagged as unverified', async () => {
  const env = await setup();
  const d = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  env.llm.queue(out => Object.assign(out, { citations: [{ sectionId: 'KL-ret-1', quote: 'members always get a free month when they ask', supports: 'x' }] }));
  const s = await env.svc.generateNextScenario(d.drillId);
  assert.ok(s.reviewFlags.find(f => f.code === 'UNVERIFIED_SOURCE' && f.blocking));
  assert.equal(s.trainer.sources[0].verified, false);
});

test('malformed model output is rejected, not stored', async () => {
  const env = await setup();
  const d = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  env.llm.queue(out => { delete out.citations; out.correctActions = ['Refund everything']; return out; });
  await assert.rejects(env.svc.generateNextScenario(d.drillId), /did not match the expected structure/);
  assert.equal((await env.svc.getDrillBundle(d.drillId)).scenarios.length, 0);
});

test('answer leaking into the ticket is a blocking flag that cannot be waived', async () => {
  const env = await setup();
  const d = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  env.llm.queue(out => Object.assign(out, { ticket: out.ticket + ' ' + out.rationale }));
  const s = await env.svc.generateNextScenario(d.drillId);
  const leak = s.reviewFlags.find(f => f.code === 'ANSWER_LEAK');
  assert.ok(leak && leak.blocking && !leak.resolvable);
  await assert.rejects(env.svc.resolveFlag(d.drillId, 'AD-001', 'ANSWER_LEAK', 'fine'), /clears automatically/);
  await env.svc.updateScenario(d.drillId, 'AD-001', { trainee: { scenario: 'Clean ticket text.' } });
  const fixed = (await env.svc.getDrillBundle(d.drillId)).scenarios[0];
  assert.ok(!fixed.reviewFlags.find(f => f.code === 'ANSWER_LEAK'));
});

test('manual scenario requires a source acknowledgement before approval', async () => {
  const env = await setup();
  const d = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  const s = await env.svc.addManualScenario(d.drillId);
  assert.ok(s.reviewFlags.find(f => f.code === 'MANUAL_ENTRY'));
  await env.svc.updateScenario(d.drillId, 'AD-001', {
    trainee: { scenario: 'Customer: my cleaner never came and I want out.', accountDetails: [{ label: 'No-show logged', value: 'Yesterday' }] },
    trainer: {
      correctAnswer: { action: ['ETF waiver'], accountDetail: 'No-show logged yesterday' },
      sources: [{ sectionId: 'KL-ret-2', quote: 'waived when the member cancels within 48 hours of a documented cleaner no-show' }]
    }
  });
  let cur = (await env.svc.getDrillBundle(d.drillId)).scenarios[0];
  assert.equal(cur.trainer.sources[0].verified, true);
  await assert.rejects(env.svc.approveDrill(d.drillId), /MANUAL_ENTRY/);
  await env.svc.resolveFlag(d.drillId, 'AD-001', 'MANUAL_ENTRY', 'Source added and verified.');
  await env.svc.approveDrill(d.drillId);
});

test('re-syncing the same export does not duplicate responses', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 1);
  await env.svc.createForm(drillId);
  env.bridge.run();
  await env.svc.refreshFormStatus(drillId);
  env.bridge.submit(drillId, { email: 'a@x.com', name: 'A', answers: { 'AD-001/action': ['Free month'] } });
  const first = await env.svc.syncResponses(drillId);
  const second = await env.svc.syncResponses(drillId);
  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal((await env.svc.getDrillBundle(drillId)).responses.length, 1);
});

test('an export for a different form is refused', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 1);
  await env.svc.createForm(drillId);
  env.bridge.run();
  await env.svc.refreshFormStatus(drillId);
  env.bridge.files[`drillform-responses__${drillId}.json`].content.formId = 'someone-elses-form';
  await assert.rejects(env.svc.syncResponses(drillId), /different form/);
});

test('triage drill requires an approved catalog and takes choices from it', async () => {
  const env = await setup();
  const d = await env.svc.createDrill({ drillType: 'TRIAGE' });
  assert.equal(d.config.targetMinutes, 30);
  await assert.rejects(env.svc.generateNextScenario(d.drillId), /Approve at least two process catalog entries/);

  const proposed = await env.svc.proposeCatalog();
  const invented = proposed.find(e => e.name === 'Invented Process');
  assert.ok(invented.flags.find(f => f.code === 'UNVERIFIED_SOURCE'));
  await assert.rejects(env.svc.updateCatalogEntry(invented.catalogId, { status: 'APPROVED' }), /No verified source/);
  for (const e of proposed.filter(x => x.name !== 'Invented Process')) {
    await env.svc.updateCatalogEntry(e.catalogId, { status: 'APPROVED' });
  }

  const s = await env.svc.generateNextScenario(d.drillId);
  assert.equal(s.scenarioId, 'TR-001');
  const proc = s.trainee.questions.find(q => q.key === 'process');
  assert.deepEqual(plain(proc.choices.slice().sort()), ['Lockout Refund', 'Unused Voucher']);
  assert.ok(!proc.choices.includes('Invented Process'));
  assert.equal(s.trainer.correctAnswer.process, 'Lockout Refund');
  assert.equal(s.trainer.correctAnswer.tag, 'lockout_refund');
  assert.equal(s.trainer.correctAnswer.checklist, 'Lockout Checklist');
  assert.deepEqual(plain(s.trainee.questions.map(q => q.key)), ['process', 'tag', 'checklist', 'reasoning']);
});

test('triage auto-scoring for process, tag and checklist', async () => {
  const env = await setup();
  const cat = await env.svc.proposeCatalog();
  for (const e of cat.filter(x => x.name !== 'Invented Process')) await env.svc.updateCatalogEntry(e.catalogId, { status: 'APPROVED' });
  const d = await env.svc.createDrill({ drillType: 'TRIAGE', scenarioCount: 1 });
  await env.svc.generateNextScenario(d.drillId);
  await env.svc.approveDrill(d.drillId);
  await env.svc.createForm(d.drillId);
  env.bridge.run();
  await env.svc.refreshFormStatus(d.drillId);
  env.bridge.submit(d.drillId, { email: 'z@x.com', name: 'Z', answers: {
    'TR-001/process': 'Lockout Refund', 'TR-001/tag': 'unused_voucher', 'TR-001/checklist': 'Lockout Checklist'
  } });
  await env.svc.syncResponses(d.drillId);
  const r = (await env.svc.getDrillBundle(d.drillId)).responses[0];
  assert.equal(r.answers['TR-001/process'].score.autoCorrect, true);
  assert.equal(r.answers['TR-001/tag'].score.autoCorrect, false);
  assert.equal(r.answers['TR-001/tag'].score.autoGapTag, 'INCORRECT_TAG');
  assert.equal(r.answers['TR-001/checklist'].score.autoCorrect, true);
});

test('lifecycle refuses skipping steps', async () => {
  const env = await setup();
  const d = await env.svc.createDrill({ drillType: 'APPROVE_DENY' });
  await assert.rejects(env.svc.approveDrill(d.drillId), /trainer review/);
  await assert.rejects(env.svc.createForm(d.drillId), /Approve the drill/);
  await env.svc.generateNextScenario(d.drillId);
  await assert.rejects(env.svc.markSent(d.drillId), /form was just created/);
});

test('form creation without a configured bridge folder fails clearly', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 1);
  await env.store.put('settings', 'main', { bridgeFolderId: '' });
  await assert.rejects(env.svc.createForm(drillId), /Form Bridge Drive folder/);
});

test('response export from the sheet fallback maps by header tags', async () => {
  const env = await setup();
  const drillId = await generatedApprovedDrill(env, 1);
  await env.svc.createForm(drillId);
  env.bridge.run();
  const d = await env.svc.refreshFormStatus(drillId);
  env.bridge.files[`drillform-responses__${drillId}.json`] = { content: {
    drillId, formId: d.form.formId, generatedAt: 'now', source: 'SHEET',
    sheet: {
      headers: ['Timestamp', 'Email Address', 'Your full name', 'AD-001 · Q1 — renamed in the sheet'],
      rows: [['2026-10-01T10:00:00Z', 'c@x.com', 'Cy', 'Free month']]
    }
  } };
  const r = await env.svc.syncResponses(drillId);
  assert.equal(r.created, 1);
  const resp = (await env.svc.getDrillBundle(drillId)).responses[0];
  assert.equal(resp.traineeEmail, 'c@x.com');
  assert.equal(resp.answers['AD-001/action'].score.autoScore, 2);
});
