// src/routes/webhook.js
const express = require('express');
const router = express.Router();
const { processInboundMessage } = require('../services/router');

function verifyWebhookSecret(req) {
  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  return secret === process.env.WEBHOOK_SECRET;
}

router.post('/heyreach', async (req, res) => {
  if (!verifyWebhookSecret(req)) {
    console.warn('[Webhook] Rejected: invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  const eventType = payload.eventType || payload.event_type || payload.type;

  console.log(`[Webhook] Received event: ${eventType}`);
  console.log(`[Webhook] Raw payload:`, JSON.stringify(payload, null, 2));

  const messageEvents = [
    'MESSAGE_REPLY_RECEIVED',
    'INMAIL_REPLY_RECEIVED',
    'message_reply_received',
    'every_message_reply_received',
    'new_message'
  ];

  if (!messageEvents.includes(eventType)) {
    console.log(`[Webhook] Ignored event type: ${eventType}`);
    return res.status(200).json({ received: true, processed: false, reason: 'event_type_not_handled' });
  }

  const campaign = payload.campaign;
  if (campaign?.id) {
    console.log(`[Webhook] Campaign: ${campaign.name || campaign.id}`);
  } else {
    console.log(`[Webhook] No campaign attached — processing anyway`);
  }

  res.status(200).json({ received: true, processing: true });

  setImmediate(async () => {
    try {
      const result = await processInboundMessage(payload);
      console.log(`[Webhook] Processed: ${result.action} for ${result.lead?.name} (autoSent: ${result.autoSent})`);
    } catch (err) {
      console.error('[Webhook] Processing error:', err.message, err.stack);
    }
  });
});

router.get('/heyreach', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'linkedin-nurture-webhook' });
});

module.exports = router;
