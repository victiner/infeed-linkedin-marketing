// src/routes/conversations.js
// REST API for managing conversations and drafts

const express = require('express');
const router = express.Router();
const store = require('../services/store');
const { processInboundMessage, sendApprovedDraft, syncConversationFromHeyReach } = require('../services/router');
const heyreach = require('../services/heyreach');
const workspace = require('../services/workspace');

// Per-conversation last-sync timestamps so GET /:id can skip a HeyReach round-
// trip when the conversation was synced in the last 30s. Reduces load when the
// dashboard polls every 30s anyway.
const lastAutoSync = new Map();
const AUTO_SYNC_TTL_MS = 30_000;

// GET /conversations — list all conversations with their latest draft
router.get('/', (req, res) => {
  const wsId = workspace.getId();
  const convos = store.getAllConversations(wsId);
  const leads = Object.fromEntries(
    store.getAllLeads(wsId).map(l => [l.id, l])
  );

  const enriched = convos.map(c => ({
    ...c,
    lead: leads[c.leadId] || null,
    pendingDraft: c.drafts.find(d => d.status === 'pending') || null,
    messageCount: c.messages.length
  }));

  res.json({ conversations: enriched, total: enriched.length });
});

// GET /conversations/:id — single conversation detail.
// Auto-syncs from HeyReach if last sync >30s ago, so outbound HeyReach activity
// (campaign step 2, manual sends from LinkedIn, etc.) appears without waiting
// for the user to click Sync. Sync is fire-and-forget on auto path: we return
// the current state immediately and the dashboard's 30s poll picks up the
// refreshed thread on the next load.
router.get('/:id', async (req, res) => {
  const convoId = req.params.id;
  const existing = store.getConversation(convoId);
  if (!existing) return res.status(404).json({ error: 'Conversation not found' });

  const last = lastAutoSync.get(convoId) || 0;
  if (Date.now() - last > AUTO_SYNC_TTL_MS) {
    lastAutoSync.set(convoId, Date.now());
    syncConversationFromHeyReach(convoId).catch(err =>
      console.warn(`[Conversations] background sync failed for ${convoId}:`, err.message)
    );
  }

  // Return whatever is in the store right now. The background sync above will
  // update it; the next 30s dashboard poll renders the fresh state.
  const convo = store.getConversation(convoId);
  const lead = store.getLead(convo.leadId);
  res.json({ conversation: convo, lead });
});

// POST /conversations/:id/sync — force a HeyReach thread sync now. Resolves
// synthetic `import-${leadId}` IDs to real HeyReach conv IDs along the way.
// Used by the dashboard's "Sync from HeyReach" button.
router.post('/:id/sync', async (req, res) => {
  try {
    const result = await syncConversationFromHeyReach(req.params.id);
    lastAutoSync.set(result.realConvId || req.params.id, Date.now());
    if (!result.conv) return res.status(404).json({ error: 'Conversation not found' });
    res.json({
      success: result.synced,
      reason: result.reason || null,
      realConvId: result.realConvId || req.params.id,
      messageCount: result.conv.messages?.length || 0,
    });
  } catch (err) {
    console.error('[Conversations] Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:id/process — manually trigger routing for a conversation
// Useful if webhook was missed or you want to re-process
router.post('/:id/process', async (req, res) => {
  try {
    const convo = store.getConversation(req.params.id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    const lead = store.getLead(convo.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Build a synthetic webhook payload from stored data
    const lastMessage = convo.messages.filter(m => m.sender === 'them').pop();
    if (!lastMessage) return res.status(400).json({ error: 'No inbound messages found' });

    const result = await processInboundMessage({
      conversationId: req.params.id,
      linkedInAccountId: convo.senderId,
      leadLinkedInUrl: lead.linkedInUrl,
      leadName: lead.name,
      leadTitle: lead.role,
      leadCompany: lead.company,
      messageText: lastMessage.text,
      timestamp: lastMessage.timestamp,
      eventType: 'MESSAGE_REPLY_RECEIVED'
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error('[Conversations] Process error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:id/send — approve and send a draft
router.post('/:id/send', async (req, res) => {
  const { draftId } = req.body;
  if (!draftId) return res.status(400).json({ error: 'draftId required' });

  try {
    const convo = store.getConversation(req.params.id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    const lead = store.getLead(convo.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const result = await sendApprovedDraft({
      conversationId: req.params.id,
      draftId,
      senderId: convo.senderId,
      linkedInProfileUrl: lead.linkedInUrl
    });

    res.json(result);
  } catch (err) {
    console.error('[Conversations] Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:id/takeover — flag for human review
router.post('/:id/takeover', (req, res) => {
  const convo = store.getConversation(req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  convo.status = 'human_takeover';
  store.logAction({
    type: 'human_takeover',
    leadId: convo.leadId,
    conversationId: req.params.id,
    data: { reason: req.body.reason || 'manual' },
    result: 'flagged'
  });

  res.json({ success: true, message: 'Conversation flagged for human review' });
});

// POST /conversations/:id/route — override the routing decision
router.post('/:id/route', async (req, res) => {
  const { routing, draftText } = req.body;
  if (!routing) return res.status(400).json({ error: 'routing required' });

  const validRoutings = ['send_job_list', 'book_call', 'send_landing_page', 'send_payment_link', 'send_onboarding_link', 'human_takeover'];
  if (!validRoutings.includes(routing)) {
    return res.status(400).json({ error: `Invalid routing. Must be one of: ${validRoutings.join(', ')}` });
  }

  const convo = store.getConversation(req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  store.addDraftToConversation(req.params.id, {
    text: draftText || '',
    routingDecision: { routing_decision: routing, stage: 'manual_override' },
    asset: null,
    autoSendEligible: false,
    manualOverride: true
  });

  store.logAction({
    type: 'manual_route_override',
    leadId: convo.leadId,
    conversationId: req.params.id,
    data: { routing },
    result: 'draft_created'
  });

  res.json({ success: true, routing });
});

module.exports = router;
