// Shared pure helpers. Loaded into the Apps Script global scope and into Node tests
// via a vm context, so everything here is plain functions and `var` globals.

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pad3(n) {
  return ('000' + n).slice(-3);
}

// djb2 string hash -> short hex. Used for change detection, not security.
function hashString(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function hashObject(obj) {
  return hashString(stableStringify(obj));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(function (k) {
    return JSON.stringify(k) + ':' + stableStringify(value[k]);
  }).join(',') + '}';
}

// Lowercase, unify quotes/dashes, collapse whitespace. Used for citation and leak matching.
function normalizeText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniq(arr) {
  var seen = {};
  return arr.filter(function (x) {
    var k = typeof x === 'string' ? x : JSON.stringify(x);
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

function isBlank(s) {
  return s == null || String(s).trim() === '';
}

function asArray(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function ServiceError(code, message, details) {
  var e = new Error(message);
  e.code = code;
  e.details = details;
  return e;
}
