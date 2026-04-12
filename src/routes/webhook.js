// src/routes/webhook.js
// Receives inbound webhook events from HeyReach
// HeyReach fires these when: a message reply is received, connection accepted, etc.

const express = require('express');
const router = express.Router();
const { processInboundMessage } = require('../services/router');

// Verify webhook authenticity using the shared secret
function verifyWebhookSecret(req) {
  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  return secret === process.env.WEBHOOK_SECRET;
}

// POST /webhook/heyreach
// Main entry point for all HeyReach webhook events
router.post('/heyreach', async (req, res) => {
  // Verify secret
  if (!verifyWebhookSecret(req)) {
    console.warn('[Webhook] Rejected: invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  const eventType = payload.eventType || payload.event_type || payload.type;

  console.log(`[Webhook] Received event: ${eventType}`);
  console.log(`[Webhook] Raw payload:`, JSON.stringify(payload, null, 2));

  // Only process message events — ignore others (connection requests, etc.)
  const messageEvents = [
    'MESSAGE_REPLY_RECEIVED',
    'INMAIL_REPLY_RECEIVED',
    'message_reply_received',
    'new_message'
  ];

  if (!messageEvents.includes(eventType)) {
    // Log but acknowledge — HeyReach expects a 200
    console.log(`[Webhook] Ignored event type: ${eventType}`);
    return res.status(200).json({ received: true, processed: false, reason: 'event_type_not_handled' });
  }

  // Acknowledge immediately — process async
  // HeyReach has a short timeout so we must respond fast
  res.status(200).json({ received: true, processing: true });

  // Process in background (don't await in the response path)
  setImmediate(async () => {
    try {
      const result = await processInboundMessage(payload);
      console.log(`[Webhook] Processed: ${result.action} for ${result.lead?.name}`);
    } catch (err) {
      console.error('[Webhook] Processing error:', err.message, err.stack);
    }
  });
});

// GET /webhook/heyreach — HeyReach pings this to verify the endpoint is live
router.get('/heyreach', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'linkedin-nurture-webhook' });
});

module.exports = router;
