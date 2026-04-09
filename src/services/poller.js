// src/services/poller.js
// Polls HeyReach for new messages on a schedule.
// Use this as a fallback if webhooks aren't configured yet,
// or as a safety net to catch any messages that webhook missed.
//
// To enable: set ENABLE_POLLER=true and POLL_INTERVAL_SECONDS=60 in .env

const heyreach = require('./heyreach');
const { processInboundMessage } = require('./router');
const store = require('./store');

let pollTimer = null;
const processedMessageIds = new Set(); // Dedup across polls

async function pollOnce() {
  console.log('[Poller] Checking HeyReach inbox...');
  try {
    const result = await heyreach.getConversationsNeedingReply();
    const conversations = result?.conversations || result?.items || result || [];

    if (!Array.isArray(conversations)) {
      console.warn('[Poller] Unexpected response shape from HeyReach:', typeof conversations);
      return;
    }

    console.log(`[Poller] Found ${conversations.length} conversations needing reply`);

    for (const convo of conversations) {
      // Get the last inbound message
      const messages = convo.messages || [];
      const lastInbound = [...messages].reverse().find(m => !m.isOurs);
      if (!lastInbound) continue;

      // Deduplicate: skip if we already processed this message
      const msgKey = `${convo.id}-${lastInbound.id || lastInbound.createdAt}`;
      if (processedMessageIds.has(msgKey)) continue;
      processedMessageIds.add(msgKey);

      // Build a webhook-compatible payload and process it
      const payload = {
        eventType: 'MESSAGE_REPLY_RECEIVED',
        conversationId: convo.id,
        linkedInAccountId: convo.linkedInAccountId || convo.senderId,
        leadLinkedInUrl: convo.leadLinkedInUrl || convo.lead?.linkedInUrl,
        leadName: convo.leadName || convo.lead?.name || 'Unknown',
        leadTitle: convo.leadTitle || convo.lead?.title || '',
        leadCompany: convo.leadCompany || convo.lead?.company || '',
        messageText: lastInbound.text,
        timestamp: lastInbound.createdAt || new Date().toISOString()
      };

      try {
        const result = await processInboundMessage(payload);
        console.log(`[Poller] Processed ${payload.leadName}: ${result.action}`);
      } catch (err) {
        console.error(`[Poller] Failed to process message from ${payload.leadName}:`, err.message);
      }

      // Small delay between processing to avoid hitting Claude rate limits
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.error('[Poller] Error during poll:', err.message);
  }
}

function start() {
  if (process.env.ENABLE_POLLER !== 'true') {
    console.log('[Poller] Disabled (set ENABLE_POLLER=true to enable)');
    return;
  }

  const intervalSeconds = parseInt(process.env.POLL_INTERVAL_SECONDS) || 60;
  console.log(`[Poller] Starting — polling every ${intervalSeconds}s`);

  // Run once immediately on start
  pollOnce();

  // Then on interval
  pollTimer = setInterval(pollOnce, intervalSeconds * 1000);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[Poller] Stopped');
  }
}

module.exports = { start, stop, pollOnce };
