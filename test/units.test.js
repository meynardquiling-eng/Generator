const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./helpers/loadCore');
const plain = v => JSON.parse(JSON.stringify(v));

const core = loadCore();

test('question tags round-trip', () => {
  const t = core.questionTag('AD-003', 1);
  assert.equal(t, 'AD-003 · Q2');
  assert.deepEqual(JSON.parse(JSON.stringify(core.parseQuestionTag(t + ' — What exact account detail...'))), { scenarioId: 'AD-003', questionNumber: 2 });
  assert.equal(core.parseQuestionTag('Your full name'), null);
});

test('sheet fallback maps by header tags even when columns are reordered or added', () => {
  const headers = ['Email Address', 'AD-001 · Q2 — What exact account detail supports your decision?', 'Extra column someone added', 'Timestamp', 'Your full name', 'AD-001 · Q1 — What action should be taken?'];
  const rows = [['a@x.com', '3 cleanings', 'zzz', '2026-10-01T10:00:00Z', 'Ana', 'Free month, ETF waiver']];
  const raw = core.rawResponsesFromSheet(headers, rows);
  const mapped = core.mapResponses('D-1', raw, [], { 'AD-001': ['action', 'accountDetail', 'explanation'] });
  const byKey = Object.fromEntries(mapped.rows.map(r => [r.questionKey, r.answer]));
  assert.equal(byKey.action, 'Free month, ETF waiver');
  assert.equal(byKey.accountDetail, '3 cleanings');
  assert.equal(mapped.responses[0].traineeName, 'Ana');
  assert.equal(mapped.responses[0].traineeId, 'email:a@x.com');
  assert.equal(mapped.unmapped.length, 1, 'unknown column reported, not silently dropped');
});

test('item-ID mapping wins over titles (a trainer renamed the question in Forms)', () => {
  const raw = [{ responseId: 'r1', submittedAt: 'x', respondentEmail: null, answers: [
    { itemId: '55', title: 'Renamed in the Forms editor', value: ['MF reduction'] },
    { itemId: '1', title: 'Your full name', value: 'Bo' }
  ] }];
  const items = [{ key: 'AD-002/action', itemId: '55', scenarioId: 'AD-002', questionKey: 'action' }];
  const m = core.mapResponses('D', raw, items, {});
  assert.equal(m.rows[0].scenarioId, 'AD-002');
  assert.equal(m.rows[0].traineeId, 'name:bo');
});

test('checkbox answers from the sheet are matched against known choices', () => {
  const choices = ['Free month', 'MF reduction', 'ETF waiver', 'None of the above'];
  assert.deepEqual(plain(core.normalizeChoiceAnswer('Free month, ETF waiver', choices).sort()), ['ETF waiver', 'Free month']);
  assert.deepEqual(plain(core.normalizeChoiceAnswer(['MF reduction'], choices)), ['MF reduction']);
  assert.deepEqual(plain(core.normalizeChoiceAnswer('Voucher refund', ['Refund', 'Voucher refund'])), ['Voucher refund']);
});

test('exact-set scoring', () => {
  const rule = { mode: 'AUTO', points: 2, method: 'EXACT_SET' };
  const choices = ['Free month', 'MF reduction', 'ETF waiver', 'None of the above'];
  assert.equal(core.computeAutoScore(rule, ['Free month', 'ETF waiver'], ['ETF waiver', 'Free month'], choices).autoScore, 2);
  assert.equal(core.computeAutoScore(rule, ['Free month'], ['Free month', 'ETF waiver'], choices).autoScore, 0);
  assert.equal(core.computeAutoScore(rule, ['None of the above'], [], choices).autoScore, 0);
});

test('manual questions get a hint, never a score', () => {
  const r = core.computeAutoScore({ mode: 'MANUAL', points: 2 }, 'Completed cleanings: 3', 'they have 3 completed cleanings');
  assert.equal(r.autoScore, null);
  assert.ok(r.assist.overlap > 0.5);
});

test('trainer score out of range is refused', () => {
  const row = { maxPoints: 2 };
  assert.throws(() => core.applyTrainerScore(row, { finalScore: 5 }, 't', 'now'), /between 0 and 2/);
});

test('trainee projection is a whitelist', () => {
  const s = { scenarioId: 'AD-001', trainee: { scenario: 'x', secret: 'nope', questions: [{ key: 'a', prompt: 'p', type: 'PARAGRAPH', scoring: { mode: 'AUTO' } }] }, trainer: { rationale: 'r' } };
  const t = core.toTraineeVersion(s);
  assert.equal(t.secret, undefined);
  assert.equal(t.questions[0].scoring, undefined);
  assert.equal(t.rationale, undefined);
});

test('form spec builder refuses trainer text', () => {
  const typeDef = core.getDrillType('APPROVE_DENY');
  const drill = { drillId: 'D', title: 'T', config: { targetMinutes: 15, scenarioCount: 1 } };
  const rationale = 'Because the member has three completed cleanings this month.';
  const s = { scenarioId: 'AD-001', status: 'ACTIVE', trainee: { scenario: 'Ticket. ' + rationale, accountDetails: [], questions: [] }, trainer: { rationale } };
  assert.throws(() => core.buildFormSpec(drill, [s], typeDef, {}), /trainer-only text/);
});

test('citation verification tolerates whitespace and smart quotes but not paraphrase', () => {
  const sections = [{ sectionId: 'S1', text: 'The member’s ETF is   waived after a no-show.' }];
  const ok = core.verifyCitations([{ sectionId: 'S9', quote: "member's ETF is waived after" }], sections);
  assert.equal(ok[0].verified, true);
  assert.equal(ok[0].sectionId, 'S1');
  const bad = core.verifyCitations([{ sectionId: 'S1', quote: 'ETF is always waived' }], sections);
  assert.equal(bad[0].verified, false);
});

test('lifecycle transitions', () => {
  const d = { drillId: 'D', status: 'DRAFT' };
  core.transitionDrill(d, 'GENERATED', 'a', 'now');
  assert.throws(() => core.transitionDrill(d, 'FORM_CREATED', 'a', 'now'), /cannot move/);
});

test('slack channel text parsing', () => {
  const text = 'Channel: #csq (C1)\n\nJane Doe:  [2026-08-03 01:59:17 CDT]\nReminder: lock-out refunds need a photo.\nSecond line.\n\nBob:  [2026-08-03 02:00:00 CDT]\n';
  const msgs = core.parseSlackChannelText(core.slackPayloadText({ messages: text }), 'C1');
  assert.equal(msgs.length, 1, 'empty messages dropped');
  assert.equal(msgs[0].author, 'Jane Doe');
  assert.match(msgs[0].text, /Second line/);
});

test('json check catches missing fields and bad enums', () => {
  const schema = core.APPROVE_DENY_TYPE.outputSchema();
  const problems = core.checkJsonAgainstSchema({ correctActions: ['Nope'] }, schema);
  assert.ok(problems.some(p => p.includes('ticket is missing')));
  assert.ok(problems.some(p => p.includes('must be one of')));
});
