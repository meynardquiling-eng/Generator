// Scoring. Objective questions are auto-scored; subjective ones wait for a trainer.
// The auto score and the trainer-approved final score are stored separately.

// Choice answers can arrive as arrays (Forms API) or as ", "-joined strings (sheet).
// Match against the known choices instead of splitting on commas, since a choice may
// itself contain a comma.
function normalizeChoiceAnswer(answer, choices) {
  if (Array.isArray(answer)) return answer.map(function (a) { return String(a).trim(); }).filter(Boolean);
  var s = String(answer == null ? '' : answer);
  if (isBlank(s)) return [];
  // Longest choices first, consuming matched text, so "Refund" is not also found inside
  // "Voucher refund".
  var rest = s;
  var picked = [];
  (choices || []).slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (c) {
    var idx = rest.indexOf(c);
    if (idx !== -1) {
      picked.push(c);
      rest = rest.slice(0, idx) + '\u0000' + rest.slice(idx + c.length);
    }
  });
  return picked.length ? picked : [s.trim()];
}

function setsEqual(a, b) {
  var na = uniq(a.map(normalizeText)).sort();
  var nb = uniq(b.map(normalizeText)).sort();
  return na.length === nb.length && na.every(function (x, i) { return x === nb[i]; });
}

// Rough overlap between the trainee's text and the expected account detail. Shown to the
// trainer as a hint only; it never sets a score.
function keywordAssist(expected, answer) {
  var stop = { the: 1, a: 1, an: 1, and: 1, or: 1, of: 1, to: 1, in: 1, on: 1, for: 1, is: 1, was: 1, has: 1, with: 1, their: 1, they: 1 };
  var terms = uniq(normalizeText(expected).split(/[^a-z0-9$%./-]+/).filter(function (w) { return w.length > 1 && !stop[w]; }));
  if (!terms.length) return { overlap: null, matchedTerms: [] };
  var ans = normalizeText(Array.isArray(answer) ? answer.join(' ') : answer);
  var matched = terms.filter(function (t) { return ans.indexOf(t) !== -1; });
  return { overlap: Math.round((matched.length / terms.length) * 100) / 100, matchedTerms: matched };
}

function computeAutoScore(rule, expected, answer, choices) {
  rule = rule || { mode: 'MANUAL', points: 0 };
  if (rule.mode !== 'AUTO') {
    return { mode: 'MANUAL', maxPoints: rule.points, autoScore: null, autoCorrect: null, assist: keywordAssist(asArray(expected).join(' '), answer) };
  }
  var given = normalizeChoiceAnswer(answer, choices);
  var exp = asArray(expected);
  var correct = rule.method === 'EXACT_SET' ? setsEqual(given, exp) : (given.length === 1 && exp.length === 1 && normalizeText(given[0]) === normalizeText(exp[0]));
  return { mode: 'AUTO', maxPoints: rule.points, autoScore: correct ? rule.points : 0, autoCorrect: correct, assist: null, normalizedAnswer: given };
}

// Build or refresh the score row for an answer. Trainer fields (finalScore, gapTags,
// coachingNote) are never overwritten here.
function scoreAnswerRow(answerRow, scenario, existing) {
  var q = (scenario.trainee.questions || []).filter(function (x) { return x.key === answerRow.questionKey; })[0];
  var rule = (scenario.trainer.scoring || {})[answerRow.questionKey];
  var expected = (scenario.trainer.correctAnswer || {})[answerRow.questionKey];
  var auto = computeAutoScore(rule, expected, answerRow.answer, q ? q.choices : []);
  var expectedHash = hashObject([expected, rule]);
  var row = existing ? deepClone(existing) : {
    answerId: answerRow.answerId, drillId: answerRow.drillId, scenarioId: answerRow.scenarioId,
    questionKey: answerRow.questionKey, traineeId: answerRow.traineeId,
    finalScore: null, finalSetBy: null, finalSetAt: null, gapTags: [], coachingNote: '', reviewStatus: null
  };
  var changed = existing && (existing.answerHash !== answerRow.answerHash || existing.expectedHash !== expectedHash);
  row.mode = auto.mode;
  row.maxPoints = auto.maxPoints;
  row.autoScore = auto.autoScore;
  row.autoCorrect = auto.autoCorrect;
  row.assist = auto.assist;
  row.normalizedAnswer = auto.normalizedAnswer || null;
  row.answerHash = answerRow.answerHash;
  row.expectedHash = expectedHash;
  row.expectedSnapshot = deepClone(expected == null ? null : expected);
  if (auto.mode === 'AUTO' && auto.autoCorrect === false && rule && rule.gapTagOnWrong) {
    row.autoGapTag = rule.gapTagOnWrong;
  } else {
    row.autoGapTag = null;
  }
  if (row.finalScore != null) {
    row.reviewStatus = changed ? 'NEEDS_REVIEW' : 'REVIEWED';
    row.staleSinceReview = !!changed || !!row.staleSinceReview;
  } else {
    row.reviewStatus = auto.mode === 'AUTO' ? 'AUTO_SCORED' : 'NEEDS_REVIEW';
  }
  return row;
}

function applyTrainerScore(row, input, actor, nowIso) {
  if (input.finalScore != null) {
    var n = Number(input.finalScore);
    if (isNaN(n) || n < 0 || n > row.maxPoints) {
      throw ServiceError('INVALID_SCORE', 'Score must be between 0 and ' + row.maxPoints + '.');
    }
    row.finalScore = n;
    row.finalSetBy = actor;
    row.finalSetAt = nowIso;
    row.reviewStatus = 'REVIEWED';
    row.staleSinceReview = false;
  }
  if (input.gapTags) row.gapTags = input.gapTags.filter(function (t) { return GAP_TAGS.indexOf(t) !== -1; });
  if (input.coachingNote != null) row.coachingNote = String(input.coachingNote);
  return row;
}

function effectiveScore(row) {
  if (row.finalScore != null) return row.finalScore;
  return row.autoScore;
}

function summarizeScores(rows) {
  var earned = 0, possible = 0, pending = 0;
  rows.forEach(function (r) {
    possible += r.maxPoints || 0;
    var e = effectiveScore(r);
    if (e == null) pending++;
    else earned += e;
  });
  return { earned: earned, possible: possible, pendingReview: pending, pct: possible ? Math.round((earned / possible) * 1000) / 10 : null };
}
