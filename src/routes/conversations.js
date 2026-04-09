// src/routes/conversations.js
// REST API for managing conversations and drafts

const express = require('express');
const router = express.Router();
const store = require('../services/store');
const { processInboundMessage, sendApprovedDraft } = require('../services/router');
const heyreach = require('../services/heyreach');

// GET /conversations — list all conversations with their latest draft
router.get('/', (req, res) => {
  const convos = store.getAllConversations();
  const leads = Object.fromEntries(
    store.getAllLeads().map(l => [l.id, l])
  );

  const enriched = convos.map(c => ({
    ...c,
    lead: leads[c.leadId] || null,
    pendingDraft: c.drafts.find(d => d.status === 'pending') || null,
    messageCount: c.messages.length
  }));

  res.json({ conversations: enriched, total: enriched.length });
});

// GET /conversations/:id — single conversation detail
router.get('/:id', (req, res) => {
  const convo = store.getConversation(req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  const lead = store.getLead(convo.leadId);
  res.json({ conversation: convo, lead });
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
