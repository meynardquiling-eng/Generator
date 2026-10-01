// Test doubles for the dashboard database, the Drive/Apps Script Form Bridge, and Claude.
// Source sections here are TEST FIXTURES ONLY. They are not Homeaglow policy.

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

class MemoryStore {
  constructor() {
    this.data = {};
    this.leases = {};
    this.failures = [];
    this.writes = 0;
  }
  coll(c) { return (this.data[c] = this.data[c] || {}); }
  // failNext('put', 'drills', (doc) => boolean?) -> next matching put throws once
  failNext(op, coll, predicate) { this.failures.push({ op, coll, predicate }); }
  maybeFail(op, coll, doc) {
    const i = this.failures.findIndex(f => f.op === op && f.coll === coll && (!f.predicate || f.predicate(doc)));
    if (i !== -1) {
      this.failures.splice(i, 1);
      const e = new Error('simulated ' + op + ' failure on ' + coll);
      e.code = 'unavailable';
      throw e;
    }
  }
  async get(c, id) { return clone(this.coll(c)[id]) || null; }
  async list(c, where) {
    return Object.values(this.coll(c)).filter(d => !where || d[where[0]] === where[1]).map(clone);
  }
  async put(c, id, obj) {
    this.maybeFail('put', c, obj);
    this.writes++;
    this.coll(c)[id] = clone(obj);
  }
  async remove(c, id) { delete this.coll(c)[id]; }
  async lease(key, holder, ttlMs) {
    const now = Date.now();
    const l = this.leases[key];
    if (l && l.holder !== holder && l.expires > now) return false;
    this.leases[key] = { holder, expires: now + ttlMs };
    return true;
  }
}

// Simulates the private Drive folder plus the Apps Script bridge that processes it.
class FakeBridge {
  constructor() {
    this.files = {};          // name -> content object
    this.forms = {};          // drillId -> form
    this.formsCreated = 0;
    this.requestFilesCreated = 0;
    this.failNextFormCreateAfterItems = 0;
    this.seq = 0;
  }
  async requestForm(folderId, drillId, spec) {
    const name = `drillform-request__${drillId}__${spec.specHash}.json`;
    if (this.files[name]) return { fileId: this.files[name].fileId, reused: true };
    this.requestFilesCreated++;
    this.files[name] = { fileId: 'file-' + (++this.seq), content: { kind: 'FORM_REQUEST', drillId, specHash: spec.specHash, spec: clone(spec) } };
    return { fileId: this.files[name].fileId, reused: false };
  }
  // One bridge run (the Apps Script trigger).
  run() {
    Object.keys(this.files).filter(n => n.startsWith('drillform-request__')).forEach(n => {
      const req = this.files[n].content;
      const resultName = `drillform-result__${req.drillId}.json`;
      const prev = this.files[resultName];
      if (prev && prev.content.status === 'CREATED' && prev.content.specHash === req.specHash) return;
      let form = this.forms[req.drillId];
      if (!form) {
        this.formsCreated++;
        form = this.forms[req.drillId] = { formId: 'form-' + this.formsCreated, items: [], responses: [], spec: req.spec };
      }
      // ensureItems: add only the items that are missing (by key)
      req.spec.items.forEach((it, i) => {
        if (!form.items.find(x => x.key === it.key)) form.items.push({ key: it.key, itemId: String(1000 * this.formsCreated + i), title: it.title, kind: it.kind });
      });
      if (this.failNextFormCreateAfterItems > 0) {
        this.failNextFormCreateAfterItems--;
        this.files[resultName] = { content: { drillId: req.drillId, specHash: req.specHash, status: 'ERROR', error: 'simulated timeout after items' } };
        return;
      }
      this.files[resultName] = {
        content: {
          drillId: req.drillId, specHash: req.specHash, status: 'CREATED', formId: form.formId,
          editUrl: 'https://forms.example/edit/' + form.formId, publishedUrl: 'https://forms.example/view/' + form.formId,
          responseSheetId: 'sheet-' + form.formId,
          items: form.items.filter(x => x.kind === 'QUESTION').map(x => ({ key: x.key, itemId: x.itemId, title: x.title })),
          processedAt: new Date().toISOString()
        }
      };
      this.exportResponses(req.drillId);
    });
  }
  exportResponses(drillId) {
    const form = this.forms[drillId];
    if (!form) return;
    this.files[`drillform-responses__${drillId}.json`] = {
      content: { drillId, formId: form.formId, generatedAt: new Date().toISOString(), source: 'FORM', responses: clone(form.responses) }
    };
  }
  // A trainee submits: answers keyed by spec item key ('AD-001/action').
  submit(drillId, { email, name, answers, responseId }) {
    const form = this.forms[drillId];
    const items = form.items.filter(x => x.kind === 'QUESTION');
    const out = [];
    const nameItem = items.find(x => x.key === '_trainee/name');
    out.push({ itemId: nameItem.itemId, title: nameItem.title, value: name });
    Object.keys(answers).forEach(k => {
      const it = items.find(x => x.key === k);
      out.push({ itemId: it.itemId, title: it.title, value: answers[k] });
    });
    form.responses.push({ responseId: responseId || 'resp-' + (form.responses.length + 1), submittedAt: new Date().toISOString(), respondentEmail: email || null, answers: out });
    this.exportResponses(drillId);
  }
  async getFormResult(folderId, drillId) { const f = this.files[`drillform-result__${drillId}.json`]; return f ? clone(f.content) : null; }
  async getResponses(folderId, drillId) { const f = this.files[`drillform-responses__${drillId}.json`]; return f ? clone(f.content) : null; }
  async requestSourceExport(folderId, docId, key) {
    this.sourceRequests = this.sourceRequests || {};
    const reused = !!this.sourceRequests[key];
    this.sourceRequests[key] = true;
    return { requested: true, reused };
  }
  async getSourceExport() { return this.sourceExport ? clone(this.sourceExport) : null; }
  async getBridgeStatus() { return this.status ? clone(this.status) : null; }
  async getSourceIndex() { return this.sourceExport ? { generatedAt: this.sourceExport.generatedAt } : null; }
  async getDocModifiedTime() { return this.docModified || null; }
}

// TEST FIXTURE sections (invented wording, used only to exercise grounding).
const FIXTURE_SECTIONS = [
  { sectionId: 'KL-ret-1', sourceType: 'KNOWLEDGE_LIBRARY', title: 'Fixture Library', heading: 'Retention > Free month', path: 'Retention > Free month', url: 'https://docs.example/ret1',
    text: 'FIXTURE: A member who has completed at least three cleanings and has not received a free month in the last 12 months may be offered one free month.' },
  { sectionId: 'KL-ret-2', sourceType: 'KNOWLEDGE_LIBRARY', title: 'Fixture Library', heading: 'Retention > ETF waiver', path: 'Retention > ETF waiver', url: 'https://docs.example/ret2',
    text: 'FIXTURE: The early termination fee is waived when the member cancels within 48 hours of a documented cleaner no-show.' },
  { sectionId: 'KL-tri-1', sourceType: 'KNOWLEDGE_LIBRARY', title: 'Fixture Library', heading: 'Triage > Lock-out refund', path: 'Triage > Lock-out refund', url: 'https://docs.example/tri1',
    text: 'FIXTURE: Lock-out refund tickets use the Lockout Refund process, tag lockout_refund, and launch the Lockout Checklist.' },
  { sectionId: 'KL-tri-2', sourceType: 'KNOWLEDGE_LIBRARY', title: 'Fixture Library', heading: 'Triage > Unused voucher', path: 'Triage > Unused voucher', url: 'https://docs.example/tri2',
    text: 'FIXTURE: Unused voucher questions use the Unused Voucher process, tag unused_voucher, and launch the Voucher Checklist.' }
];

// Deterministic stand-in for Claude. Reads the prompt, cites a quote that really exists
// in the provided sources (unless told otherwise), and returns schema-shaped JSON.
class FakeLlm {
  constructor() {
    this.calls = 0;
    this.overrides = [];
  }
  queue(fn) { this.overrides.push(fn); }
  async generateJson({ user, schema }) {
    this.calls++;
    this.prompts = (this.prompts || []).concat([user]);
    const ids = [...user.matchAll(/<source id="([^"]+)"[^\n]*\n([\s\S]*?)\n<\/source>/g)].map(m => ({ id: m[1], text: m[2] }));
    const first = ids[0];
    const quote = first ? first.text.slice(10, 70) : 'nothing';
    if (schema.properties.entries) {
      return {
        entries: [
          { name: 'Lockout Refund', sourceTitle: 'Lock-out refund', tag: 'lockout_refund', checklist: 'Lockout Checklist', category: 'Lock-out refund', whenToUse: 'Cleaner could not get in.',
            citations: [{ sectionId: 'KL-tri-1', quote: 'use the Lockout Refund process, tag lockout_refund', supports: 'process' }] },
          { name: 'Unused Voucher', sourceTitle: 'Unused voucher', tag: 'unused_voucher', checklist: 'Voucher Checklist', category: 'Unused-voucher issue', whenToUse: 'Voucher never redeemed.',
            citations: [{ sectionId: 'KL-tri-2', quote: 'use the Unused Voucher process, tag unused_voucher', supports: 'process' }] },
          { name: 'Invented Process', sourceTitle: 'Invented', tag: 'x', checklist: 'y', category: 'General retention', whenToUse: 'n/a',
            citations: [{ sectionId: 'KL-tri-2', quote: 'this sentence is not in any source at all', supports: 'none' }] }
        ]
      };
    }
    const n = this.calls;
    const base = {
      insufficientSource: false, insufficientReason: '',
      title: 'Member ' + n + ' wants to cancel',
      ticket: 'Hi, this is member number ' + n + '. My cleaner did not show up yesterday and I want to cancel my plan.',
      accountDetails: [{ label: 'Completed cleanings', value: String(2 + n) }, { label: 'Last free month', value: 'Never' }],
      rationale: 'Trainer-only rationale for scenario ' + n + ': the member qualifies based on the cleaning count.',
      commonMistakes: ['Offering an ETF waiver without a documented no-show (case ' + n + ').'],
      coachingNotes: 'Coach on reading the cleaning count first (case ' + n + ').',
      citations: [{ sectionId: first ? first.id : 'none', quote, supports: 'decision' }],
      sourceConflict: ''
    };
    let out;
    if (schema.properties.correctActions) {
      out = Object.assign(base, { correctActions: ['Free month'], requiredAccountDetail: 'Completed cleanings: ' + (2 + n) });
    } else {
      const cat = schema.properties.correctProcessId.enum || [];
      out = Object.assign(base, { category: 'Lock-out refund', correctProcessId: cat[0], requiredAccountDetail: 'Cleaner could not enter' });
    }
    const o = this.overrides.shift();
    return o ? o(out) : out;
  }
}

class FakeClock {
  constructor(today) { this.d = today || '2026-10-01'; this.t = 0; }
  today() { return this.d; }
  nowIso() { this.t++; return this.d + 'T12:00:' + String(this.t % 60).padStart(2, '0') + '.' + String(this.t).padStart(3, '0') + 'Z'; }
}

async function seedSources(store, sections) {
  await store.put('sources', 'kl-000', { chunkId: 'kl-000', sections: clone(sections || FIXTURE_SECTIONS) });
  await store.put('settings', 'main', { bridgeFolderId: 'folder-1', collectVerifiedEmail: true, csqChannels: [], sourceDocId: 'doc-1' });
}

module.exports = { MemoryStore, FakeBridge, FakeLlm, FakeClock, FIXTURE_SECTIONS, seedSources, clone };
