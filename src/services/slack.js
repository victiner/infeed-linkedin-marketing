// src/services/slack.js
// Slack incoming-webhook notifier for drafts needing human review.
// No-op if SLACK_WEBHOOK_URL is unset, so the system still runs without Slack configured.

const axios = require('axios');

async function notify({ title, lead, reason, routing, confidence, draft, conversationId }) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;

  const dashboard = process.env.DASHBOARD_URL || '';
  const link = dashboard ? `${dashboard.replace(/\/$/, '')}/?conversation=${conversationId}` : null;

  const lines = [
    `*${title}*`,
    `*Lead:* ${lead?.name || 'Unknown'}${lead?.company ? ` — ${lead.company}` : ''}`,
    reason ? `*Reason:* ${reason}` : null,
    routing ? `*Routing:* \`${routing}\`` : null,
    typeof confidence === 'number' ? `*Confidence:* ${(confidence * 100).toFixed(0)}%` : null,
    draft ? `*Draft:*\n>${String(draft).replace(/\n/g, '\n>')}` : null,
    link ? `<${link}|Open in dashboard>` : null,
  ].filter(Boolean);

  try {
    await axios.post(url, { text: lines.join('\n') }, { timeout: 5000 });
  } catch (err) {
    console.warn('[Slack] Notification failed:', err.message);
  }
}

module.exports = { notify };
