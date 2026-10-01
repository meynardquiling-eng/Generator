// Agent side: C-side agents handle customer tickets; CP Gen agents handle tickets from
// cleaner partners (CPs). The side decides who writes the ticket, which sources rank
// first, the topic list, and (for Triage) the process catalog.

var AUDIENCES = [
  {
    id: 'CUSTOMER', label: 'C-side (customer-facing)', short: 'C-side',
    sender: 'a customer (C) writing to Homeaglow Care',
    keywords: ['customer', 'membership', 'voucher', 'refund', 'retention', 'etf', 'fcf', 'dhj']
  },
  {
    id: 'CP', label: 'CP side (CP Gen)', short: 'CP side',
    sender: 'a cleaner partner (CP) writing to Homeaglow’s CP support team. Use CP-facing policy: payouts, job claims and cancellations, invoices, pending invoices, lockouts on site, ratings, tiering, profile status and deactivation',
    keywords: ['cp', 'cleaner', 'cleaner partner', 'payout', 'pay', 'claim', 'claimed', 'invoice', 'pending invoice', 'deactivation', 'tier', 'tiering', 'cp profile', 'cp-facing']
  }
];

var CP_TOPIC_PRESETS = [
  { label: 'CP lockouts', keywords: ['lockout', 'lock-out', 'locked out', 'could not get in'] },
  { label: 'CP payouts', keywords: ['payout', 'pay', 'payment', 'paid'] },
  { label: 'Job claims and CP cancellations', keywords: ['claim', 'claimed', 'cp cancel', 'cancellation'] },
  { label: 'Pending invoices', keywords: ['pending invoice', 'invoice', 'invoiced'] },
  { label: 'CP deactivation', keywords: ['deactivation', 'deactivated', 'profile status'] },
  { label: 'CP tiering', keywords: ['tier', 'tiering'] },
  { label: 'Late or no-show CP', keywords: ['no-show', 'no show', 'late', 'tardiness'] }
];

function getAudience(id) {
  return AUDIENCES.filter(function (a) { return a.id === id; })[0] || AUDIENCES[0];
}

function topicPresetsFor(audienceId) {
  return audienceId === 'CP' ? CP_TOPIC_PRESETS : TOPIC_PRESETS;
}
