// src/services/router.js
// The brain of the system — orchestrates classification, asset selection, drafting, and sending.
// Now campaign-aware: reads the active campaign step to override routing, template, and assets.

const claude = require('./claude');
const heyreach = require('./heyreach');
const assets = require('./assets');
const store = require('./store');
const campaigns = require('./campaigns');

// ---- MAIN ENTRY: process an inbound message ----

async function processInboundMessage(webhookPayload) {
  const {
    conversationId,
    senderId,
    senderProfileUrl,
    senderName,
    senderRole,
    senderCompany,
    message,
    timestamp
  } = normaliseWebhookPayload(webhookPayload);

  console.log(`[Router] Processing message from ${senderName} (${senderProfileUrl})`);

  // 1. Upsert lead record
  const lead = store.upsertLead({
    linkedInUrl: senderProfileUrl,
    name: senderName,
    role: senderRole || 'Unknown',
    company: senderCompany || 'Unknown',
    senderId
  });

  // 2. Get or build conversation thread
  const convoRecord = store.upsertConversation({
    conversationId,
    leadId: lead.id,
    senderId,
    messages: [{
      sender: 'them',
      text: message,
      timestamp: timestamp || new Date().toISOString()
    }]
  });

  // 3. Fetch full thread from HeyReach for context
  let thread = convoRecord.messages;
  try {
    const hrConvo = await heyreach.getConversationById(conversationId);
    if (hrConvo?.messages?.length) {
      thread = hrConvo.messages.map(m => ({
        sender: m.isOurs ? 'us' : 'them',
        text: m.text,
        timestamp: m.createdAt
      }));
      store.upsertConversation({ conversationId, leadId: lead.id, senderId, messages: thread });
    }
  } catch (err) {
    console.warn('[Router] Could not fetch full thread from HeyReach, using local:', err.message);
  }

  // 4. Quick sentiment check — escalate immediately if frustrated
  const sentimentCheck = await claude.classifyInboundSentiment(message);
  if (sentimentCheck.requires_human) {
    store.logAction({
      type: 'human_takeover',
      leadId: lead.id,
      conversationId,
      data: { reason: 'sentiment_check_flagged', sentiment: sentimentCheck.sentiment },
      result: 'flagged_for_human'
    });
    console.log(`[Router] Flagged for human takeover: ${senderName} (${sentimentCheck.sentiment})`);
    return { action: 'human_takeover', lead, reason: sentimentCheck.sentiment, draft: null };
  }

  // 5. Campaign matching — assign if not already in one
  const campaignMatch = campaigns.findCampaignForLead(lead, webhookPayload);
  if (campaignMatch && campaignMatch.isNew) {
    store.assignLeadToCampaign(lead.id, campaignMatch.campaign.id);
    lead.campaignId = campaignMatch.campaign.id;
    lead.currentStepIndex = 0;
    lead.lastStepAt = new Date().toISOString();
    console.log(`[Router] Assigned ${senderName} to campaign: ${campaignMatch.campaign.name}`);
  }

  // 6. Get current campaign step (may be null if no active campaign)
  const step = campaigns.getCurrentStep(lead);

  // 7. Classification and routing — include response velocity
  const leadProfile = buildLeadProfile(lead);
  const velocity = measureResponseVelocity(thread);
  leadProfile.responseVelocity = velocity;
  const routingDecision = await claude.classifyAndRoute(thread, leadProfile);

  // Override routing with campaign step if set
  if (step && step.routing) {
    console.log(`[Router] Campaign step override: ${routingDecision.routing_decision} → ${step.routing}`);
    routingDecision.routing_decision = step.routing;
  }

  // 8. Update lead stage
  store.updateLeadStage(lead.id, routingDecision.stage, routingDecision);

  // 9. Select asset — campaign step can override category
  const assetSegment = routingDecision.suggested_asset_segment || 'general';
  let selectedAsset;
  if (step && step.assetCategory) {
    // Map asset category → routing key for asset selection
    const catToRouting = {
      job_lists: 'send_job_list', landing_pages: 'send_landing_page',
      payment_links: 'send_payment_link', onboarding_links: 'send_onboarding_link',
      booking_links: 'book_call',
    };
    selectedAsset = assets.selectAsset(catToRouting[step.assetCategory] || routingDecision.routing_decision, assetSegment, lead.creditsUsed || 0);
  } else {
    selectedAsset = assets.selectAsset(routingDecision.routing_decision, assetSegment, lead.creditsUsed || 0);
  }

  // 10. Draft or render message
  let draftText;
  if (step && !step.useAI && step.template) {
    // Verbatim mode — skip Claude, send template with placeholders replaced
    draftText = campaigns.renderTemplate(step.template, lead);
    if (selectedAsset?.url) {
      draftText += `\n${selectedAsset.url}`;
    }
    console.log(`[Router] Verbatim template for ${senderName} (step ${step._stepIndex + 1}/${step._totalSteps})`);
  } else {
    // AI mode — optionally inject template as guidance
    const templateGuidance = step?.template || null;
    draftText = await claude.draftMessage(thread, leadProfile, routingDecision, selectedAsset, templateGuidance);
  }

  // 11. Store the draft
  const convoWithDraft = store.addDraftToConversation(conversationId, {
    text: draftText,
    routingDecision,
    asset: selectedAsset,
    autoSendEligible: true,
    campaignStep: step ? { campaignId: step._campaignId, stepIndex: step._stepIndex } : null
  });
  const storedDraft = convoWithDraft.drafts[convoWithDraft.drafts.length - 1];

  // 12. Auto-send or queue for review based on confidence threshold
  const AUTO_SEND_THRESHOLD = parseFloat(process.env.AUTO_SEND_THRESHOLD) || 0.85;
  const confidence = routingDecision.confidence || 0;
  const shouldAutoSend = routingDecision.routing_decision !== 'human_takeover' && confidence >= AUTO_SEND_THRESHOLD;

  if (shouldAutoSend) {
    await autoSendAndAdvance({
      senderId, senderProfileUrl, senderName,
      draftText, conversationId, lead, routingDecision, selectedAsset, storedDraft
    });
  } else if (routingDecision.routing_decision === 'human_takeover') {
    store.logAction({
      type: 'human_takeover', leadId: lead.id, conversationId,
      data: { routing: routingDecision.routing_decision, stage: routingDecision.stage },
      result: 'flagged_for_human'
    });
    console.log(`[Router] Human takeover flagged for ${senderName}`);
  } else {
    // Below threshold — draft stays pending for manual review
    store.logAction({
      type: 'draft_created', leadId: lead.id, conversationId,
      data: { routing: routingDecision.routing_decision, stage: routingDecision.stage, confidence, threshold: AUTO_SEND_THRESHOLD },
      result: 'pending_review'
    });
    console.log(`[Router] Confidence ${(confidence * 100).toFixed(0)}% < ${(AUTO_SEND_THRESHOLD * 100).toFixed(0)}% threshold — queued for review: ${senderName}`);
  }

  console.log(`[Router] Done for ${senderName}: ${routingDecision.routing_decision} (confidence: ${(confidence * 100).toFixed(0)}%, step ${step ? step._stepIndex + 1 : '-'})`);

  return {
    action: routingDecision.routing_decision,
    lead, routingDecision, asset: selectedAsset, draft: draftText,
    autoSent: shouldAutoSend
  };
}

// ---- PROACTIVE SEND: scheduler calls this for delay-elapsed steps ----

async function sendProactiveStep(lead) {
  const step = campaigns.getCurrentStep(lead);
  if (!step) return null;

  console.log(`[Router] Proactive step ${step._stepIndex + 1}/${step._totalSteps} for ${lead.name}`);

  // Build thread from latest conversation
  const allConvos = store.getAllConversations().filter(c => c.leadId === lead.id);
  const convo = allConvos[0]; // most recent
  if (!convo) {
    console.warn(`[Router] No conversation for lead ${lead.name} — skipping proactive step`);
    return null;
  }
  const thread = convo.messages || [];
  const leadProfile = buildLeadProfile(lead);

  // Run full classification against the thread so Claude sees the whole conversation
  const routingDecision = await claude.classifyAndRoute(thread, leadProfile);

  // Campaign step overrides routing if set
  if (step.routing) {
    routingDecision.routing_decision = step.routing;
  }
  routingDecision.funnel_stage = step.stage;

  // Confidence gate — same threshold as inbound messages
  const AUTO_SEND_THRESHOLD = parseFloat(process.env.AUTO_SEND_THRESHOLD) || 0.85;
  const confidence = routingDecision.confidence || 0;

  // Select asset
  const assetSegment = routingDecision.suggested_asset_segment || 'general';
  let selectedAsset = null;
  if (step.assetCategory) {
    const catToRouting = {
      job_lists: 'send_job_list', landing_pages: 'send_landing_page',
      payment_links: 'send_payment_link', onboarding_links: 'send_onboarding_link',
      booking_links: 'book_call',
    };
    selectedAsset = assets.selectAsset(catToRouting[step.assetCategory] || routingDecision.routing_decision, assetSegment, lead.creditsUsed || 0);
  } else {
    selectedAsset = assets.selectAsset(routingDecision.routing_decision, assetSegment, lead.creditsUsed || 0);
  }

  // Draft or render
  let draftText;
  if (!step.useAI && step.template) {
    draftText = campaigns.renderTemplate(step.template, lead);
    if (selectedAsset?.url) draftText += `\n${selectedAsset.url}`;
  } else {
    draftText = await claude.draftMessage(thread, leadProfile, routingDecision, selectedAsset, step.template || null);
  }

  // Store draft
  const convoWithDraft = store.addDraftToConversation(convo.id, {
    text: draftText,
    routingDecision,
    asset: selectedAsset,
    autoSendEligible: true,
    campaignStep: { campaignId: step._campaignId, stepIndex: step._stepIndex }
  });
  const storedDraft = convoWithDraft.drafts[convoWithDraft.drafts.length - 1];

  // Confidence gate: auto-send or queue for review
  if (confidence >= AUTO_SEND_THRESHOLD) {
    await autoSendAndAdvance({
      senderId: lead.senderId, senderProfileUrl: lead.linkedInUrl, senderName: lead.name,
      draftText, conversationId: convo.id, lead, routingDecision, selectedAsset, storedDraft
    });
    console.log(`[Router] Proactive auto-sent to ${lead.name}: ${routingDecision.routing_decision} (confidence: ${(confidence * 100).toFixed(0)}%)`);
  } else {
    store.logAction({
      type: 'draft_created', leadId: lead.id, conversationId: convo.id,
      data: { routing: routingDecision.routing_decision, confidence, threshold: AUTO_SEND_THRESHOLD, proactive: true },
      result: 'pending_review'
    });
    console.log(`[Router] Proactive step queued for review: ${lead.name} (confidence: ${(confidence * 100).toFixed(0)}% < ${(AUTO_SEND_THRESHOLD * 100).toFixed(0)}%)`);
  }

  return { action: routingDecision.routing_decision, lead, draft: draftText, autoSent: confidence >= AUTO_SEND_THRESHOLD };
}

// ---- SHARED: auto-send + advance campaign step ----

async function autoSendAndAdvance({ senderId, senderProfileUrl, senderName, draftText, conversationId, lead, routingDecision, selectedAsset, storedDraft }) {
  const delayMs = Math.floor(Math.random() * 60_000);
  console.log(`[Router] Sending to ${senderName} in ${Math.round(delayMs / 1000)}s`);
  await new Promise(r => setTimeout(r, delayMs));

  try {
    await heyreach.sendMessage({ senderId, linkedInProfileUrl: senderProfileUrl, message: draftText });
    store.markDraftSent(conversationId, storedDraft.id);
    store.updateLeadStage(lead.id, routingDecision.stage, routingDecision, selectedAsset?.id);
    store.logAction({
      type: 'message_sent', leadId: lead.id, conversationId,
      data: { routing: routingDecision.routing_decision, stage: routingDecision.stage, asset: selectedAsset?.id, autoSent: true, campaignId: lead.campaignId || null },
      result: 'sent'
    });
    // Advance campaign step
    if (lead.campaignId) {
      store.advanceLeadStep(lead.id);
      console.log(`[Router] Advanced ${senderName} to step ${(lead.currentStepIndex || 0) + 2}`);
    }
    console.log(`[Router] Auto-sent to ${senderName}: ${routingDecision.routing_decision}`);
  } catch (err) {
    console.error(`[Router] Auto-send failed for ${senderName}:`, err.message);
    store.logAction({
      type: 'draft_created', leadId: lead.id, conversationId,
      data: { routing: routingDecision.routing_decision, stage: routingDecision.stage, asset: selectedAsset?.id, autoSendFailed: true },
      result: 'draft_ready'
    });
  }
}

// ---- MANUAL: send an approved draft ----

async function sendApprovedDraft({ conversationId, draftId, senderId, linkedInProfileUrl }) {
  const convo = store.getConversation(conversationId);
  if (!convo) throw new Error(`Conversation not found: ${conversationId}`);

  const draft = convo.drafts.find(d => d.id === draftId && d.status === 'pending');
  if (!draft) throw new Error(`Draft not found or already sent: ${draftId}`);

  const result = await heyreach.sendMessage({ senderId, linkedInProfileUrl, message: draft.text });
  store.markDraftSent(conversationId, draftId);

  const lead = store.getLead(convo.leadId);
  if (lead) {
    store.updateLeadStage(lead.id, draft.routingDecision?.stage || lead.stage, draft.routingDecision?.routing_decision, draft.asset?.id);
    try {
      await heyreach.updateLeadTags({
        senderId, linkedInProfileUrl,
        tags: [draft.routingDecision?.stage, draft.routingDecision?.routing_decision].filter(Boolean)
      });
    } catch (err) {
      console.warn('[Router] Could not update HeyReach tags:', err.message);
    }
    // Advance campaign step if this draft was from a campaign
    if (lead.campaignId && draft.campaignStep) {
      store.advanceLeadStep(lead.id);
    }
  }

  store.logAction({
    type: 'message_sent', leadId: convo.leadId, conversationId,
    data: { routing: draft.routingDecision?.routing_decision, assetId: draft.asset?.id },
    result: result
  });

  return { success: true, result };
}

// ---- RESPONSE VELOCITY ----

/**
 * Measure how fast the lead is responding.
 * Returns { avgMinutes, fastResponder, messageCount }
 * fastResponder = true if average reply time is under 30 minutes.
 */
function measureResponseVelocity(thread) {
  const theirMessages = [];
  const ourMessages = [];
  for (const m of thread) {
    if (m.sender === 'them' && m.timestamp) theirMessages.push(new Date(m.timestamp).getTime());
    if (m.sender === 'us' && m.timestamp) ourMessages.push(new Date(m.timestamp).getTime());
  }

  if (ourMessages.length === 0 || theirMessages.length < 2) {
    return { avgMinutes: null, fastResponder: false, messageCount: theirMessages.length };
  }

  // Measure: for each of our messages, how quickly did they reply?
  const gaps = [];
  for (const ourTs of ourMessages) {
    const nextReply = theirMessages.find(t => t > ourTs);
    if (nextReply) gaps.push(nextReply - ourTs);
  }

  if (gaps.length === 0) return { avgMinutes: null, fastResponder: false, messageCount: theirMessages.length };

  const avgMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const avgMinutes = Math.round(avgMs / 60_000);
  return { avgMinutes, fastResponder: avgMinutes < 30, messageCount: theirMessages.length };
}

// ---- HELPERS ----

function buildLeadProfile(lead) {
  return {
    name: lead.name,
    role: lead.role,
    company: lead.company,
    linkedInUrl: lead.linkedInUrl,
    currentStage: lead.stage,
    funnelStage: lead.funnelStage || 'cold_opener',
    lastAssetSent: lead.lastAssetSent,
    creditsUsed: lead.creditsUsed || 0,
    creditsTotal: lead.creditsTotal || 20,
    trialStarted: lead.trialStarted || false,
    trialExpired: lead.trialExpired || false
  };
}

function normaliseWebhookPayload(payload) {
  return {
    conversationId: payload.conversationId || payload.conversation_id || payload.threadId,
    senderId: payload.linkedInAccountId || payload.sender_id || payload.accountId,
    senderProfileUrl: payload.leadLinkedInUrl || payload.lead_linkedin_url || payload.profileUrl,
    senderName: payload.leadName || payload.lead_name || payload.name || 'Unknown',
    senderRole: payload.leadTitle || payload.lead_title || payload.title || '',
    senderCompany: payload.leadCompany || payload.lead_company || payload.company || '',
    message: payload.messageText || payload.message_text || payload.text || payload.message || '',
    timestamp: payload.timestamp || payload.createdAt || new Date().toISOString()
  };
}

module.exports = { processInboundMessage, sendProactiveStep, sendApprovedDraft };
