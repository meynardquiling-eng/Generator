// Source grounding: pick the relevant source sections for a drill and verify that every
// quote the generator cites really exists in the approved source material.
//
// Section: { sectionId, sourceType: 'KNOWLEDGE_LIBRARY'|'CSQ_SLACK', title, heading, path, url, text }

var MIN_QUOTE_LENGTH = 12;

// priorityKeywords (the drill topic) outweigh the drill type's own keywords.
function selectSections(sections, keywords, maxChars, priorityKeywords) {
  maxChars = maxChars || 60000;
  var groups = [[(keywords || []).map(normalizeText).filter(Boolean), 1], [(priorityKeywords || []).map(normalizeText).filter(Boolean), 6]];
  var scored = sections.map(function (s) {
    var heading = normalizeText(s.path || s.heading);
    var text = normalizeText(s.text);
    var score = 0;
    groups.forEach(function (g) {
      g[0].forEach(function (k) {
        if (heading.indexOf(k) !== -1) score += 5 * g[1];
        var idx = text.indexOf(k);
        var hits = 0;
        while (idx !== -1 && hits < 10) {
          hits++;
          idx = text.indexOf(k, idx + k.length);
        }
        score += hits * g[1];
      });
    });
    return { section: s, score: score };
  }).filter(function (x) { return x.score > 0; });
  scored.sort(function (a, b) { return b.score - a.score; });
  var out = [];
  var total = 0;
  scored.forEach(function (x) {
    var len = (x.section.text || '').length;
    if (total + len > maxChars && out.length) return;
    out.push(x.section);
    total += len;
  });
  return out;
}

function formatSectionsForPrompt(sections) {
  return sections.map(function (s) {
    return '<source id="' + s.sectionId + '" type="' + s.sourceType + '" heading="' +
      String(s.path || s.heading || '').replace(/"/g, "'") + '">\n' + s.text + '\n</source>';
  }).join('\n\n');
}

// citations: [{ sectionId, quote }] -> same list with verified/heading/url filled in.
function verifyCitations(citations, sections) {
  var byId = {};
  sections.forEach(function (s) { byId[s.sectionId] = s; });
  return (citations || []).map(function (c) {
    var quote = normalizeText(c.quote);
    var result = {
      sourceType: null, sectionId: c.sectionId || null, title: null, heading: null,
      url: null, quote: c.quote || '', supports: c.supports || '', verified: false
    };
    if (quote.length < MIN_QUOTE_LENGTH) return result;
    var candidates = byId[c.sectionId] ? [byId[c.sectionId]] : [];
    candidates = candidates.concat(sections.filter(function (s) { return s.sectionId !== c.sectionId; }));
    for (var i = 0; i < candidates.length; i++) {
      var s = candidates[i];
      if (normalizeText(s.text).indexOf(quote) !== -1) {
        result.sectionId = s.sectionId;
        result.sourceType = s.sourceType;
        result.title = s.title;
        result.heading = s.path || s.heading;
        result.url = s.url;
        result.verified = true;
        break;
      }
    }
    return result;
  });
}

// Review flags derived from source verification. Unsupported answers are flagged for the
// trainer instead of being presented as policy.
function sourceFlags(verifiedSources, sectionsProvided) {
  var flags = [];
  if (!sectionsProvided) {
    flags.push(makeFlag('NO_SOURCE_MATERIAL', 'No approved source sections matched this drill type. Refresh sources or check the source configuration.', true));
    return flags;
  }
  var verified = verifiedSources.filter(function (s) { return s.verified; });
  if (!verifiedSources.length || !verified.length) {
    flags.push(makeFlag('UNVERIFIED_SOURCE', 'None of the cited quotes could be found in the approved sources. Confirm the answer key against the source before approving.', true));
  }
  return flags;
}

function makeFlag(code, message, blocking, resolvable) {
  return {
    code: code, message: message, blocking: !!blocking,
    resolvable: resolvable === undefined ? true : !!resolvable,
    resolved: false, resolvedBy: null, resolvedNote: null
  };
}
