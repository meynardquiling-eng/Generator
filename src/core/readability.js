// Keeps generated tickets short, plain and current. Problems found here trigger one
// automatic rewrite; anything left after that becomes a small note for the trainer.

var READ_LIMITS = { ticketWords: 90, titleWords: 7, detailCount: 6, detailWords: 10, rationaleWords: 45 };

// Fields that do not exist in Homeaglow's agent tools.
var INVENTED_FIELD_RE = /\b(app\s*version|device|browser|operating\s*system|os\s*version|ip\s*address|user\s*agent|build\s*number|sdk)\b/i;

var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

// Every explicit date in the text: "Sep 24, 2026", "September 2026", "2026-09-24", "9/24/2026".
function findDates(text) {
  var out = [];
  var s = String(text || '');
  var m;
  var re1 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})?,?\s*(\d{4})\b/gi;
  while ((m = re1.exec(s))) out.push({ text: m[0], date: new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase().slice(0, 4)] !== undefined ? MONTHS[m[1].toLowerCase().slice(0, 4)] : MONTHS[m[1].toLowerCase().slice(0, 3)], +(m[2] || 1))) });
  var re2 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = re2.exec(s))) out.push({ text: m[0], date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) });
  var re3 = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  while ((m = re3.exec(s))) out.push({ text: m[0], date: new Date(Date.UTC(+m[3], +m[1] - 1, +m[2])) });
  return out;
}

function scenarioTraineeText(out) {
  return [out.title, out.ticket].concat((out.accountDetails || []).map(function (d) { return d.label + ': ' + d.value; })).join('\n');
}

// today: 'YYYY-MM-DD'. Dates must fall within the last 12 months or the next 2 months.
function checkReadability(out, today) {
  var problems = [];
  if (wordCount(out.ticket) > READ_LIMITS.ticketWords) problems.push('Ticket is ' + wordCount(out.ticket) + ' words; keep it under ' + READ_LIMITS.ticketWords + '.');
  if (wordCount(out.title) > READ_LIMITS.titleWords) problems.push('Title is too long; use ' + READ_LIMITS.titleWords + ' words or fewer.');
  if ((out.accountDetails || []).length > READ_LIMITS.detailCount) problems.push('Use at most ' + READ_LIMITS.detailCount + ' account details.');
  (out.accountDetails || []).forEach(function (d) {
    if (wordCount(d.value) > READ_LIMITS.detailWords) problems.push('Account detail "' + d.label + '" is too long; keep each value under ' + READ_LIMITS.detailWords + ' words.');
  });
  (out.accountDetails || []).forEach(function (d) {
    if (INVENTED_FIELD_RE.test(d.label || '')) problems.push('Account detail "' + d.label + '" is not a field agents see; remove it.');
  });
  if (wordCount(out.rationale) > READ_LIMITS.rationaleWords) problems.push('Rationale is too long; 2 short sentences.');
  var now = new Date(today + 'T00:00:00Z').getTime();
  var day = 24 * 3600 * 1000;
  findDates(scenarioTraineeText(out)).forEach(function (d) {
    var t = d.date.getTime();
    if (isNaN(t)) return;
    if (t < now - 366 * day || t > now + 62 * day) problems.push('Date "' + d.text + '" is not current; use dates within the last 12 months of ' + today + '.');
  });
  return problems;
}

function humanDate(today) {
  var d = new Date(today + 'T00:00:00Z');
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}
