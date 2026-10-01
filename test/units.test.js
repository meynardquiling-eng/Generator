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

test('undocumented tag and checklist questions are left out without a flag', () => {
  const t = core.getDrillType('TRIAGE');
  const catalog = [{ catalogId: 'P1', name: 'Unused Voucher', tag: '', checklist: '' }, { catalogId: 'P2', name: 'Lockout', tag: 'x', checklist: 'y' }];
  const key = t.buildAnswerKey({ correctProcessId: 'P1', requiredAccountDetail: 'd', category: 'Voucher refund' }, { catalog }, t.questions({ catalog }));
  assert.equal(key.flags.length, 0);
  assert.deepEqual(plain(key.questions.map(q => q.key)), ['process', 'reasoning']);
});

test('readability check catches stale dates and wordy tickets', () => {
  const ok = { title: 'Wants to cancel', ticket: 'Please cancel my plan.', accountDetails: [{ label: 'Last cleaning', value: 'Sep 22, 2026' }], rationale: 'Short.' };
  assert.deepEqual(plain(core.checkReadability(ok, '2026-10-01')), []);
  const old = Object.assign({}, ok, { accountDetails: [{ label: 'Signed up', value: 'March 3, 2023' }, { label: 'Paid', value: '2024-01-05' }] });
  assert.equal(core.checkReadability(old, '2026-10-01').filter(p => /not current/.test(p)).length, 2);
  const long = Object.assign({}, ok, { ticket: 'word '.repeat(120) });
  assert.ok(core.checkReadability(long, '2026-10-01').some(p => /words/.test(p)));
});

test('topic keywords and library topics', () => {
  assert.ok(core.topicKeywords('Lockout tickets').includes('locked out'));
  assert.deepEqual(plain(core.topicKeywords('Pet hair complaints')), ['pet hair complaints', 'pet', 'hair', 'complaints']);
  const sections = [{ sourceType: 'KNOWLEDGE_LIBRARY', path: 'Unused DHJ Voucher > A', text: 'x' }, { sourceType: 'KNOWLEDGE_LIBRARY', path: 'Unused DHJ Voucher > B', text: 'y' }, { sourceType: 'KNOWLEDGE_LIBRARY', path: 'Welcome Page > A', text: 'z' }, { sourceType: 'KNOWLEDGE_LIBRARY', path: 'Welcome Page > B', text: 'z' }];
  assert.deepEqual(plain(core.libraryTopics(sections)), ['Unused DHJ Voucher']);
});

// Formats as the Slack connector returns them (invented content).
const DETAILED_CHANNEL = [
  'Channel: #csq-test (C1)',
  '',
  '=== Message from Ana Cruz <ana@example.com> (U111) at 2026-08-17 19:20:53 CDT === ',
  'Message TS: 1787012453.806019',
  '<@U999|Claude> <@U222|Ben Lim> Legacy DHJ| C 7004279',
  '',
  'C bought a voucher, then disputed it. Should I reinstate it or charge full price?',
  'Thread: 2 replies (latest: 2026-08-19 11:25:35 CDT)',
  '',
  '=== Message from Bo Diaz <bo@example.com> (U333) at 2026-08-17 13:01:29 CDT === ',
  'Message TS: 1786989689.406889',
  'ok',
].join('\n');

const THREAD = [
  '=== THREAD PARENT MESSAGE ===', 'From: Ana Cruz <ana@example.com> (U111)', 'Time: 2026-08-17 19:20:53 CDT', 'Message TS: 1787012453.806019', 'question text',
  '', '=== THREAD REPLIES (2 total) ===', '', '--- Reply 1 of 2 ---', 'From: Ben Lim <ben@example.com> (U222)', 'Time: 2026-08-17 20:00:00 CDT', 'Message TS: 1787014000.1',
  '<@U111|Ana Cruz>', '• Offer the retention attempt first.', '', '--- Reply 2 of 2 ---', 'From: Ana Cruz <ana@example.com> (U111)', 'Time: 2026-08-17 20:05:00 CDT', 'Message TS: 1787014300.1', 'Thanks!'
].join('\n');

test('slack detailed channel format parses messages, ts and reply counts', () => {
  const msgs = core.parseSlackChannelText(core.slackPayloadText({ messages: DETAILED_CHANNEL }), 'C1');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].author, 'Ana Cruz');
  assert.equal(msgs[0].ts, '1787012453.806019');
  assert.equal(msgs[0].replyCount, 2);
  assert.match(msgs[0].text, /disputed it/);
});

test('slack threads join the question with the replies, without emails or record numbers', () => {
  const msgs = core.parseSlackChannelText(DETAILED_CHANNEL, 'C1');
  msgs[0].replies = core.parseSlackThreadText(THREAD);
  assert.equal(msgs[0].replies.length, 2);
  assert.equal(msgs[0].replies[0].author, 'Ben Lim');
  const sections = core.slackSections(msgs, { id: 'C1', name: 'csq-test' });
  assert.equal(sections.length, 1, '"ok" is too short to keep');
  const t = sections[0].text;
  assert.match(t, /Replies:\n- Ben Lim: @Ana Cruz\n• Offer the retention attempt first\./);
  assert.ok(!/7004279|@example\.com|U222/.test(t), t);
  assert.match(t, /C \[id\]/);
  assert.match(sections[0].heading, /2 replies/);
});
