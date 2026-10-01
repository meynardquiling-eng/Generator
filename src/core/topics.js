// Drill topics. A trainer picks a preset, a Knowledge Library topic, or types their own;
// the topic steers which source sections are used and what every ticket is about.

var TOPIC_PRESETS = [
  { label: 'Lockout tickets', keywords: ['lockout', 'lock-out', 'locked out', 'lock out', 'could not get in', 'access'] },
  { label: 'Unused DHJ vouchers', keywords: ['unused dhj', 'dhj voucher', 'unused voucher', 'voucher'] },
  { label: 'FCF memberships', keywords: ['fcf', 'forever clean flex', 'membership fee', 'mf'] },
  { label: 'Legacy FC / DHJ memberships', keywords: ['legacy', 'dhj', 'forever clean', 'fc table'] },
  { label: 'ETF waivers', keywords: ['etf', 'early termination', 'waive', 'waiver'] },
  { label: 'Free month offers', keywords: ['free month', 'retention offer', 'retention'] },
  { label: 'MF reductions', keywords: ['mf reduction', 'membership fee', 'reduce', 'discount'] },
  { label: 'Voucher refunds', keywords: ['voucher refund', 'self-refund', 'refund link', 'voucher'] },
  { label: 'Refund requests', keywords: ['refund', 'chargeback', 'dispute'] },
  { label: 'Cancellations and retention', keywords: ['cancel', 'cancellation', 'retention', 'retain'] }
];

var TOPIC_STOPWORDS = { the: 1, and: 1, for: 1, with: 1, tickets: 1, ticket: 1, issues: 1, issue: 1, about: 1, cases: 1, case: 1 };

function topicKeywords(topic) {
  if (isBlank(topic)) return [];
  var all = TOPIC_PRESETS.concat(typeof CP_TOPIC_PRESETS !== 'undefined' ? CP_TOPIC_PRESETS : []);
  var preset = all.filter(function (p) { return normalizeText(p.label) === normalizeText(topic); })[0];
  if (preset) return preset.keywords.slice();
  var words = normalizeText(topic).split(/[^a-z0-9-]+/).filter(function (w) { return w.length >= 3 && !TOPIC_STOPWORDS[w]; });
  return uniq([normalizeText(topic)].concat(words));
}

// Top-level Knowledge Library topics (tab names) for the topic picker.
function libraryTopics(sections) {
  var counts = {};
  (sections || []).forEach(function (s) {
    if (s.sourceType !== 'KNOWLEDGE_LIBRARY' || !s.path) return;
    var top = s.path.split(' > ')[0].trim();
    if (top && top.length <= 60) counts[top] = (counts[top] || 0) + 1;
  });
  return Object.keys(counts).filter(function (t) { return counts[t] >= 2 && !/table of contents|welcome/i.test(t); }).sort();
}

function sectionsMatchingTopic(sections, topic) {
  var kws = topicKeywords(topic).map(normalizeText);
  if (!kws.length) return sections;
  return sections.filter(function (s) {
    var hay = normalizeText((s.path || s.heading || '') + ' ' + s.text);
    return kws.some(function (k) { return hay.indexOf(k) !== -1; });
  });
}
