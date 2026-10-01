// Explicit drill lifecycle. A generated scenario is never treated as approved.

var DrillStatus = {
  DRAFT: 'DRAFT',
  GENERATED: 'GENERATED',
  TRAINER_REVIEW: 'TRAINER_REVIEW',
  APPROVED: 'APPROVED',
  FORM_CREATING: 'FORM_CREATING',
  FORM_CREATED: 'FORM_CREATED',
  SENT: 'SENT',
  RESPONSES_RECEIVED: 'RESPONSES_RECEIVED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  COMPLETED: 'COMPLETED'
};

var DRILL_TRANSITIONS = {
  DRAFT: ['GENERATED', 'TRAINER_REVIEW'],
  GENERATED: ['TRAINER_REVIEW'],
  TRAINER_REVIEW: ['APPROVED'],
  APPROVED: ['TRAINER_REVIEW', 'FORM_CREATING'],
  FORM_CREATING: ['FORM_CREATED'],
  FORM_CREATED: ['SENT', 'RESPONSES_RECEIVED'],
  SENT: ['RESPONSES_RECEIVED'],
  RESPONSES_RECEIVED: ['UNDER_REVIEW', 'COMPLETED'],
  UNDER_REVIEW: ['COMPLETED'],
  COMPLETED: ['UNDER_REVIEW']
};

// Statuses in which trainee-facing content may still change.
var EDITABLE_STATUSES = ['DRAFT', 'GENERATED', 'TRAINER_REVIEW', 'APPROVED'];

// Statuses in which a form exists (or is being created): trainee content is frozen.
var FORM_STATUSES = ['FORM_CREATING', 'FORM_CREATED', 'SENT', 'RESPONSES_RECEIVED', 'UNDER_REVIEW', 'COMPLETED'];

function canTransition(from, to) {
  return from === to || (DRILL_TRANSITIONS[from] || []).indexOf(to) !== -1;
}

function transitionDrill(drill, to, actor, nowIso) {
  var from = drill.status;
  if (from === to) return drill;
  if (!canTransition(from, to)) {
    throw ServiceError('INVALID_TRANSITION', 'Drill ' + drill.drillId + ' cannot move from ' + from + ' to ' + to);
  }
  drill.status = to;
  drill.statusHistory = drill.statusHistory || [];
  drill.statusHistory.push({ from: from, to: to, at: nowIso, by: actor });
  drill.updatedAt = nowIso;
  return drill;
}

function isTraineeContentEditable(status) {
  return EDITABLE_STATUSES.indexOf(status) !== -1;
}

function hasForm(status) {
  return FORM_STATUSES.indexOf(status) !== -1;
}
