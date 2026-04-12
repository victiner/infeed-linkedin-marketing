// src/services/store.js
// Airtable-backed store with in-memory cache
//
// Required Airtable tables (create in your base):
//
//   Leads         — id, linkedInUrl, name, role, company, senderId, tags,
//                   stage, funnelStage, sentiment, lastRoutingDecision,
//                   lastAssetSent, creditsUsed, creditsTotal,
//                   trialStarted, trialExpired, callBooked, converted,
//                   createdAt, updatedAt
//
//   Conversations — id, leadId, senderId, messages, drafts, status,
//                   createdAt, updatedAt
//
//   Actions       — id, type, leadId, conversationId, data, result, timestamp
//
// All complex fields (messages, drafts, data, etc.) are stored as JSON strings.
// All write operations update the in-memory cache immediately and sync to
// Airtable in the background — callers never wait for Airtable.

const { v4: uuidv4 } = require('uuid');
const Airtable = require('airtable');

// Parse base ID — handle "appXXX/tblXXX" URL format copied from Airtable
const BASE_ID = (process.env.AIRTABLE_BASE_ID || '').split('/')[0];

const TABLES = {
  leads:         process.env.AIRTABLE_LEADS_TABLE         || 'Leads',
  conversations: process.env.AIRTABLE_CONVERSATIONS_TABLE || 'Conversations',
  actions:       process.env.AIRTABLE_ACTIONS_TABLE       || 'Actions',
  training:      process.env.AIRTABLE_TRAINING_TABLE      || 'Training',
  ratings:       process.env.AIRTABLE_RATINGS_TABLE       || 'Ratings',
};

let base = null;

function getBase() {
  if (!base && process.env.AIRTABLE_API_KEY && BASE_ID) {
    base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(BASE_ID);
  }
  return base;
}

// In-memory cache
const leads         = new Map(); // leadId → lead
const conversations = new Map(); // conversationId → conversation
const actions       = [];        // append-only
const trainingPreferences = [];  // recorded user style choices

// Airtable record ID cache: our ID → Airtable record id
const atIds = {
  leads:         new Map(),
  conversations: new Map(),
};

// ---- AIRTABLE SYNC HELPERS (fire-and-forget) ----

function safeStr(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

function safeJSON(val) {
  if (!val) return null;
  try { return JSON.parse(val); } catch { return val; }
}

async function syncLead(lead) {
  const b = getBase();
  if (!b) return;
  try {
    const fields = {
      id:                   lead.id,
      linkedInUrl:          lead.linkedInUrl || '',
      name:                 lead.name || '',
      role:                 lead.role || '',
      company:              lead.company || '',
      senderId:             lead.senderId || '',
      tags:                 JSON.stringify(lead.tags || []),
      stage:                lead.stage || 'cold',
      funnelStage:          lead.funnelStage || 'cold_opener',
      sentiment:            lead.sentiment || 'neutral',
      lastRoutingDecision:  JSON.stringify(lead.lastRoutingDecision || null),
      lastAssetSent:        lead.lastAssetSent || '',
      creditsUsed:          lead.creditsUsed || 0,
      creditsTotal:         lead.creditsTotal || 20,
      trialStarted:         lead.trialStarted || false,
      trialExpired:         lead.trialExpired || false,
      callBooked:           lead.callBooked || false,
      converted:            lead.converted || false,
      campaignId:           lead.campaignId || '',
      currentStepIndex:     lead.currentStepIndex || 0,
      lastStepAt:           lead.lastStepAt || '',
      createdAt:            lead.createdAt || '',
      updatedAt:            lead.updatedAt || '',
    };
    const existing = atIds.leads.get(lead.id);
    if (existing) {
      await b(TABLES.leads).update(existing, fields);
    } else {
      const [rec] = await b(TABLES.leads).create([{ fields }]);
      atIds.leads.set(lead.id, rec.id);
    }
  } catch (err) {
    console.warn('[Store] Airtable lead sync failed:', err.message);
  }
}

async function syncConversation(convo) {
  const b = getBase();
  if (!b) return;
  try {
    const fields = {
      id:        convo.id,
      leadId:    convo.leadId || '',
      senderId:  convo.senderId || '',
      messages:  JSON.stringify(convo.messages || []),
      drafts:    JSON.stringify(convo.drafts || []),
      status:    convo.status || 'active',
      createdAt: convo.createdAt || '',
      updatedAt: convo.updatedAt || '',
    };
    const existing = atIds.conversations.get(convo.id);
    if (existing) {
      await b(TABLES.conversations).update(existing, fields);
    } else {
      const [rec] = await b(TABLES.conversations).create([{ fields }]);
      atIds.conversations.set(convo.id, rec.id);
    }
  } catch (err) {
    console.warn('[Store] Airtable conversation sync failed:', err.message);
  }
}

async function syncAction(action) {
  const b = getBase();
  if (!b) return;
  try {
    await b(TABLES.actions).create([{ fields: {
      id:             action.id,
      type:           action.type || '',
      leadId:         action.leadId || '',
      conversationId: action.conversationId || '',
      data:           JSON.stringify(action.data || {}),
      result:         safeStr(action.result),
      timestamp:      action.timestamp || '',
    }}]);
  } catch (err) {
    console.warn('[Store] Airtable action sync failed:', err.message);
  }
}

// ---- STARTUP: load from Airtable ----

async function init() {
  const b = getBase();
  if (!b) {
    console.log('[Store] Airtable not configured — using in-memory store only');
    return;
  }
  console.log('[Store] Loading data from Airtable...');

  // Leads
  try {
    const records = await b(TABLES.leads).select({ maxRecords: 10000 }).all();
    for (const rec of records) {
      const f = rec.fields;
      if (!f.id) continue;
      const lead = {
        id:                   f.id,
        linkedInUrl:          f.linkedInUrl || '',
        name:                 f.name || '',
        role:                 f.role || '',
        company:              f.company || '',
        senderId:             f.senderId || '',
        tags:                 safeJSON(f.tags) || [],
        stage:                f.stage || 'cold',
        funnelStage:          f.funnelStage || 'cold_opener',
        sentiment:            f.sentiment || 'neutral',
        lastRoutingDecision:  safeJSON(f.lastRoutingDecision),
        lastAssetSent:        f.lastAssetSent || null,
        creditsUsed:          f.creditsUsed || 0,
        creditsTotal:         f.creditsTotal || 20,
        trialStarted:         f.trialStarted || false,
        trialExpired:         f.trialExpired || false,
        callBooked:           f.callBooked || false,
        converted:            f.converted || false,
        campaignId:           f.campaignId || null,
        currentStepIndex:     f.currentStepIndex || 0,
        lastStepAt:           f.lastStepAt || null,
        createdAt:            f.createdAt || new Date().toISOString(),
        updatedAt:            f.updatedAt || new Date().toISOString(),
      };
      leads.set(lead.id, lead);
      atIds.leads.set(lead.id, rec.id);
    }
    console.log(`[Store] Loaded ${leads.size} leads`);
  } catch (err) {
    console.warn('[Store] Could not load leads from Airtable:', err.message);
  }

  // Conversations
  try {
    const records = await b(TABLES.conversations).select({ maxRecords: 10000 }).all();
    for (const rec of records) {
      const f = rec.fields;
      if (!f.id) continue;
      const convo = {
        id:        f.id,
        leadId:    f.leadId || '',
        senderId:  f.senderId || '',
        messages:  safeJSON(f.messages) || [],
        drafts:    safeJSON(f.drafts) || [],
        status:    f.status || 'active',
        createdAt: f.createdAt || new Date().toISOString(),
        updatedAt: f.updatedAt || new Date().toISOString(),
      };
      conversations.set(convo.id, convo);
      atIds.conversations.set(convo.id, rec.id);
    }
    console.log(`[Store] Loaded ${conversations.size} conversations`);
  } catch (err) {
    console.warn('[Store] Could not load conversations from Airtable:', err.message);
  }

  // Actions
  try {
    const records = await b(TABLES.actions).select({
      maxRecords: 10000,
      sort: [{ field: 'timestamp', direction: 'asc' }]
    }).all();
    for (const rec of records) {
      const f = rec.fields;
      if (!f.id) continue;
      actions.push({
        id:             f.id,
        type:           f.type || '',
        leadId:         f.leadId || '',
        conversationId: f.conversationId || '',
        data:           safeJSON(f.data) || {},
        result:         safeJSON(f.result) || '',
        timestamp:      f.timestamp || new Date().toISOString(),
      });
    }
    console.log(`[Store] Loaded ${actions.length} actions`);
  } catch (err) {
    console.warn('[Store] Could not load actions from Airtable:', err.message);
  }
}

// ---- LEAD OPERATIONS ----

function upsertLead({ linkedInUrl, name, role, company, senderId, tags = [] }) {
  const existing = [...leads.values()].find(l => l.linkedInUrl === linkedInUrl);
  if (existing) {
    Object.assign(existing, { name, role, company, updatedAt: new Date().toISOString() });
    if (tags.length) existing.tags = [...new Set([...existing.tags, ...tags])];
    leads.set(existing.id, existing);
    syncLead(existing);
    return existing;
  }

  const lead = {
    id: uuidv4(),
    linkedInUrl,
    name,
    role,
    company,
    senderId,
    tags,
    stage:               'cold',
    funnelStage:         'cold_opener',
    sentiment:           'neutral',
    lastRoutingDecision: null,
    lastAssetSent:       null,
    creditsUsed:         0,
    creditsTotal:        20,
    trialStarted:        false,
    trialExpired:        false,
    callBooked:          false,
    converted:           false,
    campaignId:          null,
    currentStepIndex:    0,
    lastStepAt:          null,
    createdAt:           new Date().toISOString(),
    updatedAt:           new Date().toISOString(),
  };
  leads.set(lead.id, lead);
  syncLead(lead);
  return lead;
}

function updateLeadStage(leadId, stage, routingDecision = null, assetSent = null) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  lead.stage = stage;
  if (routingDecision) {
    lead.lastRoutingDecision = routingDecision;
    if (routingDecision.funnel_stage) lead.funnelStage = routingDecision.funnel_stage;
  }
  if (assetSent) lead.lastAssetSent = assetSent;
  lead.updatedAt = new Date().toISOString();
  leads.set(leadId, lead);
  syncLead(lead);
  return lead;
}

function getLeadByUrl(linkedInUrl) {
  return [...leads.values()].find(l => l.linkedInUrl === linkedInUrl) || null;
}

function getLead(leadId) {
  return leads.get(leadId) || null;
}

function getAllLeads() {
  return [...leads.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// ---- CAMPAIGN-LEAD OPERATIONS ----

function assignLeadToCampaign(leadId, campaignId) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  lead.campaignId = campaignId;
  lead.currentStepIndex = 0;
  lead.lastStepAt = new Date().toISOString();
  lead.updatedAt = new Date().toISOString();
  leads.set(leadId, lead);
  syncLead(lead);
  return lead;
}

function advanceLeadStep(leadId) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  lead.currentStepIndex = (lead.currentStepIndex || 0) + 1;
  lead.lastStepAt = new Date().toISOString();
  lead.updatedAt = new Date().toISOString();
  leads.set(leadId, lead);
  syncLead(lead);
  return lead;
}

function getLeadsInCampaign(campaignId) {
  return [...leads.values()].filter(l => l.campaignId === campaignId);
}

// ---- CONVERSATION OPERATIONS ----

function upsertConversation({ conversationId, leadId, senderId, messages = [] }) {
  const existing = conversations.get(conversationId);
  if (existing) {
    if (messages.length) {
      const existingKeys = new Set(existing.messages.map(m => `${m.timestamp}-${m.text}`));
      const newMessages = messages.filter(m => !existingKeys.has(`${m.timestamp}-${m.text}`));
      existing.messages = [...existing.messages, ...newMessages]
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }
    existing.updatedAt = new Date().toISOString();
    conversations.set(conversationId, existing);
    syncConversation(existing);
    return existing;
  }

  const convo = {
    id: conversationId,
    leadId,
    senderId,
    messages,
    drafts: [],
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  conversations.set(conversationId, convo);
  syncConversation(convo);
  return convo;
}

function addDraftToConversation(conversationId, draft) {
  const convo = conversations.get(conversationId);
  if (!convo) return null;
  convo.drafts.push({
    ...draft,
    id:        uuidv4(),
    status:    'pending',
    createdAt: new Date().toISOString(),
  });
  convo.updatedAt = new Date().toISOString();
  conversations.set(conversationId, convo);
  syncConversation(convo);
  return convo;
}

function markDraftSent(conversationId, draftId) {
  const convo = conversations.get(conversationId);
  if (!convo) return null;
  const draft = convo.drafts.find(d => d.id === draftId);
  if (draft) {
    draft.status = 'sent';
    draft.sentAt = new Date().toISOString();
  }
  conversations.set(conversationId, convo);
  syncConversation(convo);
  return convo;
}

function getConversation(conversationId) {
  return conversations.get(conversationId) || null;
}

function getAllConversations() {
  return [...conversations.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// ---- CREDIT MANAGEMENT ----

function useCredit(leadId) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  if (!lead.trialStarted) lead.trialStarted = true;
  lead.creditsUsed = (lead.creditsUsed || 0) + 1;
  if (lead.creditsUsed >= lead.creditsTotal) lead.trialExpired = true;
  lead.updatedAt = new Date().toISOString();
  leads.set(leadId, lead);
  syncLead(lead);
  logAction({
    type:   'credit_used',
    leadId,
    data:   { creditsUsed: lead.creditsUsed, creditsTotal: lead.creditsTotal },
    result: lead.trialExpired ? 'trial_expired' : 'trial_active',
  });
  return lead;
}

function getCreditStatus(leadId) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  return {
    creditsUsed:        lead.creditsUsed || 0,
    creditsTotal:       lead.creditsTotal || 20,
    creditsLeft:        (lead.creditsTotal || 20) - (lead.creditsUsed || 0),
    trialStarted:       lead.trialStarted || false,
    trialExpired:       lead.trialExpired || false,
    shouldNudgePayment: (lead.creditsUsed || 0) >= 15,
  };
}

// ---- ACTION LOG ----

function logAction({ type, leadId, conversationId, data, result }) {
  const action = {
    id: uuidv4(),
    type,
    leadId:         leadId || '',
    conversationId: conversationId || '',
    data,
    result,
    timestamp: new Date().toISOString(),
  };
  actions.push(action);
  syncAction(action);
}

function getActionLog(limit = 100) {
  return actions.slice(-limit).reverse();
}

// ---- ASSET STATS ----

function getAssetStats(assetId) {
  const sent    = actions.filter(a => a.type === 'message_sent'  && a.data?.assetId === assetId);
  const drafted = actions.filter(a => a.type === 'draft_created' && a.data?.assetId === assetId);
  const deliveries = sent.map(a => {
    const lead = leads.get(a.leadId);
    return {
      leadId:         a.leadId,
      leadName:       lead?.name    || 'Unknown',
      leadCompany:    lead?.company || '',
      conversationId: a.conversationId,
      sentAt:         a.timestamp,
      routing:        a.data?.routing,
      autoSent:       a.data?.autoSent || false,
    };
  });
  return { assetId, totalDeliveries: sent.length, totalDrafts: drafted.length, deliveries };
}

// ---- ANALYTICS ----

function getAnalytics() {
  const allLeads = getAllLeads();

  const stageCount = allLeads.reduce((acc, l) => {
    acc[l.stage] = (acc[l.stage] || 0) + 1;
    return acc;
  }, {});

  const funnelStageCount = allLeads.reduce((acc, l) => {
    const fs = l.funnelStage || 'cold_opener';
    acc[fs] = (acc[fs] || 0) + 1;
    return acc;
  }, {});

  const sentActions = actions.filter(a => a.type === 'message_sent');

  const routingCount = sentActions.reduce((acc, a) => {
    const route = a.data?.routing;
    if (route) acc[route] = (acc[route] || 0) + 1;
    return acc;
  }, {});

  // Per-route conversion: which routing actions preceded a converted lead
  const leadRoutesMap = {}; // leadId → Set of routing types received
  for (const a of sentActions) {
    if (!a.leadId || !a.data?.routing) continue;
    if (!leadRoutesMap[a.leadId]) leadRoutesMap[a.leadId] = new Set();
    leadRoutesMap[a.leadId].add(a.data.routing);
  }
  const conversionByRoute   = {};
  const totalLeadsByRoute   = {};
  for (const [leadId, routes] of Object.entries(leadRoutesMap)) {
    const lead = leads.get(leadId);
    for (const route of routes) {
      totalLeadsByRoute[route] = (totalLeadsByRoute[route] || 0) + 1;
      if (lead?.converted) conversionByRoute[route] = (conversionByRoute[route] || 0) + 1;
    }
  }

  // Conversion by funnel stage (what stage were converted leads in at conversion time)
  const conversionByFunnelStage = allLeads
    .filter(l => l.converted)
    .reduce((acc, l) => {
      const fs = l.funnelStage || 'unknown';
      acc[fs] = (acc[fs] || 0) + 1;
      return acc;
    }, {});

  const trialStarts      = allLeads.filter(l => l.trialStarted).length;
  const totalCreditsUsed = allLeads.reduce((sum, l) => sum + (l.creditsUsed || 0), 0);
  const today            = new Date().toDateString();

  return {
    totalLeads:             allLeads.length,
    totalConversations:     conversations.size,
    stageBreakdown:         stageCount,
    funnelStageBreakdown:   funnelStageCount,
    routingBreakdown:       routingCount,
    callsBooked:            allLeads.filter(l => l.callBooked).length,
    conversions:            allLeads.filter(l => l.converted).length,
    humanTakeovers:         actions.filter(a => a.type === 'human_takeover').length,
    trialStarts,
    totalCreditsUsed,
    conversionByRoute,
    totalLeadsByRoute,
    conversionByFunnelStage,
    actionsToday:           actions.filter(a => new Date(a.timestamp).toDateString() === today).length,
  };
}

// ---- TRAINING PREFERENCES ----

function addTrainingPreference(pref) {
  trainingPreferences.push(pref);
  // Sync to Airtable
  const b = getBase();
  if (b) {
    b(TABLES.training).create([{ fields: {
      Type: pref.type || 'draft',
      Scenario: safeStr(pref.scenario),
      Chosen: safeStr(pref.chosen),
      OptionIndex: pref.optionIndex ?? -1,
      IsCustom: pref.isCustom ? 'Yes' : 'No',
      Timestamp: pref.timestamp,
    }}]).catch(err => console.warn('[Store] Airtable training sync failed:', err.message));
  }
}

function getTrainingPreferences() {
  return trainingPreferences;
}

function clearTrainingPreferences() {
  trainingPreferences.length = 0;
}

// ---- MESSAGE RATINGS ----

const messageRatings = [];

function addMessageRating(rating) {
  messageRatings.push(rating);
  // Sync to Airtable
  const b = getBase();
  if (b) {
    b(TABLES.ratings).create([{ fields: {
      ConversationId: rating.conversationId,
      LeadName: rating.leadName,
      MessageText: safeStr(rating.messageText),
      Rating: rating.rating,
      Category: rating.category || '',
      Feedback: rating.feedback || '',
      WasAutoSent: rating.wasAutoSent ? 'Yes' : 'No',
      Timestamp: rating.timestamp,
    }}]).catch(err => console.warn('[Store] Airtable rating sync failed:', err.message));
  }
}

function getMessageRatings() {
  return messageRatings;
}

// Load training data from Airtable on startup
async function loadTraining() {
  const b = getBase();
  if (!b) return;
  try {
    const records = await b(TABLES.training).select({ maxRecords: 500, sort: [{ field: 'Timestamp', direction: 'asc' }] }).all();
    for (const r of records) {
      let scenario;
      try { scenario = JSON.parse(r.get('Scenario') || '{}'); } catch { scenario = {}; }
      trainingPreferences.push({
        type: r.get('Type') || 'draft',
        scenario,
        chosen: r.get('Chosen') || '',
        optionIndex: r.get('OptionIndex') ?? -1,
        isCustom: r.get('IsCustom') === 'Yes',
        timestamp: r.get('Timestamp') || '',
      });
    }
    console.log(`[Store] Loaded ${trainingPreferences.length} training preferences`);
  } catch (err) {
    console.warn('[Store] Could not load training data:', err.message);
  }
}

module.exports = {
  init,
  upsertLead,
  updateLeadStage,
  getLeadByUrl,
  getLead,
  getAllLeads,
  assignLeadToCampaign,
  advanceLeadStep,
  getLeadsInCampaign,
  upsertConversation,
  addDraftToConversation,
  markDraftSent,
  getConversation,
  getAllConversations,
  useCredit,
  getCreditStatus,
  logAction,
  getActionLog,
  getAssetStats,
  getAnalytics,
  addTrainingPreference,
  getTrainingPreferences,
  clearTrainingPreferences,
  addMessageRating,
  getMessageRatings,
  loadTraining,
};
