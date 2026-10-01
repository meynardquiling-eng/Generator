// Maps raw form submissions onto drill / scenario / question / trainee.
//
// Raw response: { responseId, submittedAt, respondentEmail, answers: [{ itemId, title, value }] }
//
// Mapping order for each answer:
//   1. Form item ID (stable for the life of the form) via the stored FormItems map.
//   2. The "AD-001 · Q2" tag at the start of the question title / sheet header.
//   3. Exact identity-question title.
// Column positions are never used.

function mapResponses(drillId, rawResponses, formItems, keysByScenario) {
  var byItemId = {};
  formItems.forEach(function (fi) { if (fi.itemId) byItemId[String(fi.itemId)] = fi; });

  var rows = [];
  var unmapped = [];
  var responses = [];

  rawResponses.forEach(function (r) {
    var name = null;
    var mappedAnswers = [];
    (r.answers || []).forEach(function (a) {
      var target = resolveTarget(a, byItemId, keysByScenario);
      if (!target) {
        unmapped.push({ responseId: r.responseId, title: a.title, itemId: a.itemId || null });
        return;
      }
      if (target.key === IDENTITY_ITEM_KEY) {
        name = Array.isArray(a.value) ? a.value.join(' ') : String(a.value || '');
        return;
      }
      mappedAnswers.push({ scenarioId: target.scenarioId, questionKey: target.questionKey, value: a.value });
    });

    var traineeId = traineeIdFor(r.respondentEmail, name);
    responses.push({ responseId: r.responseId, traineeId: traineeId, traineeName: name, traineeEmail: r.respondentEmail || null, submittedAt: r.submittedAt });
    mappedAnswers.forEach(function (m) {
      var answer = Array.isArray(m.value) ? m.value.slice() : (m.value == null ? '' : String(m.value));
      rows.push({
        answerId: makeAnswerId(drillId, r.responseId, m.scenarioId, m.questionKey),
        drillId: drillId,
        responseId: r.responseId,
        scenarioId: m.scenarioId,
        scenarioUid: makeScenarioUid(drillId, m.scenarioId),
        questionKey: m.questionKey,
        traineeId: traineeId,
        traineeName: name,
        traineeEmail: r.respondentEmail || null,
        submittedAt: r.submittedAt,
        answer: answer,
        answerHash: hashObject(answer)
      });
    });
  });

  return { rows: rows, unmapped: unmapped, responses: responses };
}

function resolveTarget(answer, byItemId, keysByScenario) {
  if (answer.itemId != null && byItemId[String(answer.itemId)]) {
    var fi = byItemId[String(answer.itemId)];
    return { key: fi.key, scenarioId: fi.scenarioId, questionKey: fi.questionKey };
  }
  var tag = parseQuestionTag(answer.title);
  if (tag && keysByScenario[tag.scenarioId]) {
    var qk = keysByScenario[tag.scenarioId][tag.questionNumber - 1];
    if (qk) return { key: tag.scenarioId + '/' + qk, scenarioId: tag.scenarioId, questionKey: qk };
  }
  if (normalizeText(answer.title) === normalizeText(IDENTITY_ITEM_TITLE)) {
    return { key: IDENTITY_ITEM_KEY, scenarioId: null, questionKey: null };
  }
  return null;
}

// Fallback reader for the linked response spreadsheet. Headers are matched by name, so
// reordered or inserted columns do not break mapping.
function rawResponsesFromSheet(headers, rows) {
  var norm = headers.map(normalizeText);
  var tsCol = norm.indexOf('timestamp');
  var emailCol = norm.indexOf('email address');
  return rows.filter(function (row) {
    return row.some(function (c) { return !isBlank(c); });
  }).map(function (row) {
    var ts = tsCol === -1 ? '' : row[tsCol];
    var email = emailCol === -1 ? '' : row[emailCol];
    var tsIso = ts instanceof Date ? ts.toISOString() : String(ts);
    var answers = [];
    headers.forEach(function (h, i) {
      if (i === tsCol || i === emailCol) return;
      answers.push({ itemId: null, title: h, value: row[i] });
    });
    return {
      responseId: 'sheet:' + hashString(tsIso + '|' + email + '|' + JSON.stringify(row)),
      submittedAt: tsIso,
      respondentEmail: email || null,
      answers: answers
    };
  });
}
