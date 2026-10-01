// Cohort and trainee performance analysis over scored answers.

function buildCoachingReport(drills, answers, scores) {
  var drillById = {};
  drills.forEach(function (d) { drillById[d.drillId] = d; });
  var answerById = {};
  answers.forEach(function (a) { answerById[a.answerId] = a; });

  var trainees = {};
  var gapCounts = {};
  var questionStats = {};
  var wrongChoices = {};
  var drillTrend = {};

  scores.forEach(function (row) {
    var answer = answerById[row.answerId] || {};
    var drill = drillById[row.drillId] || {};
    var t = trainees[row.traineeId] = trainees[row.traineeId] || {
      traineeId: row.traineeId, name: answer.traineeName || null, email: answer.traineeEmail || null,
      drills: {}, rows: [], gaps: {}
    };
    t.rows.push(row);
    t.drills[row.drillId] = true;

    var tags = uniq((row.gapTags || []).concat(row.autoGapTag && row.finalScore == null ? [row.autoGapTag] : []));
    if (row.finalScore != null && row.autoGapTag && row.finalScore < row.maxPoints && tags.indexOf(row.autoGapTag) === -1) tags.push(row.autoGapTag);
    tags.forEach(function (g) {
      gapCounts[g] = (gapCounts[g] || 0) + 1;
      t.gaps[g] = (t.gaps[g] || 0) + 1;
    });

    var qk = (drill.drillType || '?') + ':' + row.questionKey;
    var qs = questionStats[qk] = questionStats[qk] || { drillType: drill.drillType, questionKey: row.questionKey, answered: 0, correct: 0, pending: 0 };
    qs.answered++;
    var eff = effectiveScore(row);
    if (eff == null) qs.pending++;
    else if (eff >= row.maxPoints) qs.correct++;

    if (row.mode === 'AUTO' && row.autoCorrect === false) {
      var key = qk + '|' + asArray(row.expectedSnapshot).join(' + ') + '|' + asArray(row.normalizedAnswer).join(' + ');
      wrongChoices[key] = wrongChoices[key] || {
        drillType: drill.drillType, questionKey: row.questionKey,
        expected: asArray(row.expectedSnapshot).join(' + '), given: asArray(row.normalizedAnswer).join(' + ') || '(blank)',
        count: 0, scenarioIds: []
      };
      wrongChoices[key].count++;
      wrongChoices[key].scenarioIds = uniq(wrongChoices[key].scenarioIds.concat([row.scenarioId]));
    }

    var dt = drillTrend[row.drillId] = drillTrend[row.drillId] || { drillId: row.drillId, drillType: drill.drillType, createdAt: drill.createdAt, rows: [] };
    dt.rows.push(row);
  });

  var traineeList = Object.keys(trainees).map(function (id) {
    var t = trainees[id];
    var s = summarizeScores(t.rows);
    return {
      traineeId: id, name: t.name, email: t.email, drills: Object.keys(t.drills).length,
      earned: s.earned, possible: s.possible, pct: s.pct, pendingReview: s.pendingReview,
      topGaps: Object.keys(t.gaps).map(function (g) { return { tag: g, count: t.gaps[g] }; }).sort(function (a, b) { return b.count - a.count; })
    };
  }).sort(function (a, b) { return (a.pct == null ? 101 : a.pct) - (b.pct == null ? 101 : b.pct); });

  return {
    trainees: traineeList,
    gaps: Object.keys(gapCounts).map(function (g) { return { tag: g, count: gapCounts[g] }; }).sort(function (a, b) { return b.count - a.count; }),
    questions: Object.keys(questionStats).map(function (k) {
      var q = questionStats[k];
      var scored = q.answered - q.pending;
      q.accuracyPct = scored ? Math.round((q.correct / scored) * 1000) / 10 : null;
      return q;
    }),
    commonWrongAnswers: Object.keys(wrongChoices).map(function (k) { return wrongChoices[k]; }).sort(function (a, b) { return b.count - a.count; }),
    trend: Object.keys(drillTrend).map(function (id) {
      var d = drillTrend[id];
      var s = summarizeScores(d.rows);
      return { drillId: id, drillType: d.drillType, createdAt: d.createdAt, pct: s.pct, answers: d.rows.length };
    }).sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; })
  };
}
