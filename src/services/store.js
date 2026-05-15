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
const fs = require('fs');
const path = require('path');

// ---- LOCAL TRAINING BACKUP -------------------------------------------------
// Every training preference is also written to a local JSON file. This means:
//   1. If Airtable is unavailable / rate-limited / misconfigured (no API key
//      on the current machine), the record still survives a server restart.
//   2. On startup, after loading from Airtable, we replay any local-only
//      records (those without an airtableId in Airtable) so the in-memory
//      store has everything you ever trained, regardless of which machine.
//   3. forceResyncTrainingToAirtable() can re-push any in-memory records that
//      lack an airtableId to Airtable when it recovers.
const TRAINING_BACKUP_PATH = path.join(__dirname, '..', '..', 'data', 'training-backup.jsonl');
function ensureBackupDir() {
  try { fs.mkdirSync(path.dirname(TRAINING_BACKUP_PATH), { recursive: true }); } catch {}
}
function appendTrainingBackup(pref) {
  try {
    ensureBackupDir();
    // JSONL: one record per line. Append-only, so concurrent writes can't
    // corrupt the file mid-record. Reads happen only at startup.
    fs.appendFileSync(TRAINING_BACKUP_PATH, JSON.stringify(pref) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[Store] Local training backup write failed:', err.message);
  }
}
function readTrainingBackup() {
  try {
    if (!fs.existsSync(TRAINING_BACKUP_PATH)) return [];
    const raw = fs.readFileSync(TRAINING_BACKUP_PATH, 'utf-8');
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.warn('[Store] Local training backup read failed:', err.message);
    return [];
  }
}

// Parse base ID — handle "appXXX/tblXXX" URL format copied from Airtable.
// Read from env at CALL time, not module load, so the dashboard's settings
// panel can update credentials at runtime and have them take effect.
function currentBaseId() {
  return (process.env.AIRTABLE_BASE_ID || '').split('/')[0];
}

const TABLES = {
  leads:         process.env.AIRTABLE_LEADS_TABLE         || 'Leads',
  conversations: process.env.AIRTABLE_CONVERSATIONS_TABLE || 'Conversations',
  actions:       process.env.AIRTABLE_ACTIONS_TABLE       || 'Actions',
  training:      process.env.AIRTABLE_TRAINING_TABLE      || 'Training',
  ratings:       process.env.AIRTABLE_RATINGS_TABLE       || 'Ratings',
};

let base = null;

function getBase() {
  const baseId = currentBaseId();
  if (!base && process.env.AIRTABLE_API_KEY && baseId) {
    base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(baseId);
  }
  return base;
}

// Invalidate the cached Airtable client. Called by the settings route after
// the user updates AIRTABLE_API_KEY / AIRTABLE_BASE_ID via the dashboard, so
// the next getBase() call rebuilds the client with the new credentials.
function resetAirtableClient() {
  base = null;
}

// In-memory cache
const leads         = new Map(); // leadId → lead
const conversations = new Map(); // conversationId → conversation
const actions       = [];        // append-only
const trainingPreferences = [];  // recorded user style choices

// Write-time index: Map<workspaceId, Map<scenarioKey, count>>
// Maintained incrementally on every addTrainingPreference() — O(1) lookup per scenario key.
// Avoids scanning the full preferences array to count per-scenario ratings.
const scenarioCounts = new Map();

function _scenarioKey(scenario) {
  const s = (scenario && typeof scenario === 'object') ? scenario : {};
  const seniority = s.seniority || 'unknown';
  const stage = s.stage || s.funnelStage || 'unknown';
  const leadName = (s.lead?.name || '').replace(/\s+/g, '_');
  return `${seniority}_${stage}_${leadName}`;
}

function _incrementScenarioCount(workspaceId, scenario) {
  const key = _scenarioKey(scenario);
  if (!scenarioCounts.has(workspaceId)) scenarioCounts.set(workspaceId, new Map());
  const wsMap = scenarioCounts.get(workspaceId);
  wsMap.set(key, (wsMap.get(key) || 0) + 1);
}

function getScenarioCount(workspaceId, scenario) {
  const wsMap = scenarioCounts.get(workspaceId);
  if (!wsMap) return 0;
  return wsMap.get(_scenarioKey(scenario)) || 0;
}

function getScenarioCountsForWorkspace(workspaceId) {
  return scenarioCounts.get(workspaceId) || new Map();
}

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

// Strip dashboard-only metadata from a thread before serializing it for
// storage. Without this, sim-thread messages carry their full guidance
// breakdown (canonical examples, Q&A pulls, corrections, etc.) on each turn,
// which can balloon the JSON well past Airtable's 100K Long-text limit.
// We only need sender + text + a few flags downstream — strip everything else.
function sanitizeThread(thread) {
  if (!Array.isArray(thread)) return [];
  return thread
    .filter(m => m && typeof m.sender === 'string' && typeof m.text === 'string')
    .map(m => {
      const out = { sender: m.sender, text: m.text };
      // Preserve flags that affect render but cost nothing to keep.
      if (m._synthesized) out._synthesized = true;
      if (m._ghost) out._ghost = true;
      if (m._followUp) out._followUp = true;
      if (m._edited) out._edited = true;
      if (m.original && typeof m.original === 'string') out.original = m.original;
      return out;
    });
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
      notes:                JSON.stringify(lead.notes || {}),
      notesUpdatedAt:       lead.notesUpdatedAt || '',
      createdAt:            lead.createdAt || '',
      updatedAt:            lead.updatedAt || '',
      WorkspaceId:          lead.workspaceId || '',
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
      id:          convo.id,
      leadId:      convo.leadId || '',
      senderId:    convo.senderId || '',
      messages:    JSON.stringify(convo.messages || []),
      drafts:      JSON.stringify(convo.drafts || []),
      status:      convo.status || 'active',
      createdAt:   convo.createdAt || '',
      updatedAt:   convo.updatedAt || '',
      WorkspaceId: convo.workspaceId || '',
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
      WorkspaceId:    action.workspaceId || '',
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
        notes:                safeJSON(f.notes) || {},
        notesUpdatedAt:       f.notesUpdatedAt || null,
        createdAt:            f.createdAt || new Date().toISOString(),
        updatedAt:            f.updatedAt || new Date().toISOString(),
        workspaceId:          f.WorkspaceId || 'infeed',
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
        id:          f.id,
        leadId:      f.leadId || '',
        senderId:    f.senderId || '',
        messages:    safeJSON(f.messages) || [],
        drafts:      safeJSON(f.drafts) || [],
        status:      f.status || 'active',
        createdAt:   f.createdAt || new Date().toISOString(),
        updatedAt:   f.updatedAt || new Date().toISOString(),
        workspaceId: f.WorkspaceId || 'infeed',
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
        workspaceId:    f.WorkspaceId || 'infeed',
      });
    }
    console.log(`[Store] Loaded ${actions.length} actions`);
  } catch (err) {
    console.warn('[Store] Could not load actions from Airtable:', err.message);
  }
}

// ---- LEAD OPERATIONS ----

function upsertLead({ linkedInUrl, name, role, company, senderId, tags = [], notes = {}, about = '' }) {
  // Build the patch of notes additions: explicit notes object plus any free-text
  // about/headline fields. Empty values are dropped so they don't overwrite
  // existing notes with blanks.
  const notesPatch = { ...(notes || {}) };
  if (about) notesPatch.about = about;
  Object.keys(notesPatch).forEach(k => {
    if (notesPatch[k] === '' || notesPatch[k] == null) delete notesPatch[k];
  });

  const existing = [...leads.values()].find(l => l.linkedInUrl === linkedInUrl);
  if (existing) {
    Object.assign(existing, { name, role, company, updatedAt: new Date().toISOString() });
    if (tags.length) existing.tags = [...new Set([...existing.tags, ...tags])];
    if (Object.keys(notesPatch).length) {
      existing.notes = { ...(existing.notes || {}), ...notesPatch };
      existing.notesUpdatedAt = new Date().toISOString();
    }
    leads.set(existing.id, existing);
    syncLead(existing);
    return existing;
  }

  const wsModule = require('./workspace');
  const lead = {
    id: uuidv4(),
    linkedInUrl,
    name,
    role,
    company,
    senderId,
    tags,
    workspaceId:         wsModule.getId(),
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
    notes:               notesPatch,
    notesUpdatedAt:      Object.keys(notesPatch).length ? new Date().toISOString() : null,
    createdAt:           new Date().toISOString(),
    updatedAt:           new Date().toISOString(),
  };
  leads.set(lead.id, lead);
  syncLead(lead);
  return lead;
}

// Update notes for a lead (merges with existing). Used by the notes extraction service
// and by manual overrides from the UI.
function updateLeadNotes(leadId, notes) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  lead.notes = { ...(lead.notes || {}), ...(notes || {}) };
  lead.notesUpdatedAt = new Date().toISOString();
  lead.updatedAt = new Date().toISOString();
  leads.set(leadId, lead);
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

// Delete a lead and cascade to its conversations. Removes from in-memory maps
// and (best-effort) from Airtable. Returns a summary of what was deleted.
async function deleteLead(leadId) {
  const lead = leads.get(leadId);
  if (!lead) return { deleted: false, reason: 'not_found' };

  const relatedConvos = [...conversations.values()].filter(c => c.leadId === leadId);
  const b = getBase();

  // Best-effort Airtable cleanup — failures shouldn't block the in-memory delete.
  for (const convo of relatedConvos) {
    const recId = atIds.conversations.get(convo.id);
    if (b && recId) {
      try { await b(TABLES.conversations).destroy(recId); }
      catch (err) { console.warn(`[Store] Airtable convo destroy failed for ${convo.id}:`, err.message); }
    }
    atIds.conversations.delete(convo.id);
    conversations.delete(convo.id);
  }

  const leadRecId = atIds.leads.get(leadId);
  if (b && leadRecId) {
    try { await b(TABLES.leads).destroy(leadRecId); }
    catch (err) { console.warn(`[Store] Airtable lead destroy failed for ${leadId}:`, err.message); }
  }
  atIds.leads.delete(leadId);
  leads.delete(leadId);

  logAction({
    type: 'lead_deleted', leadId,
    data: { name: lead.name, linkedInUrl: lead.linkedInUrl, conversationsRemoved: relatedConvos.length },
    result: 'deleted',
  });

  return { deleted: true, leadId, conversationsRemoved: relatedConvos.length };
}

function getAllLeads(workspaceId) {
  let all = [...leads.values()];
  if (workspaceId) all = all.filter(l => l.workspaceId === workspaceId);
  return all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
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

  const wsModule = require('./workspace');
  const convo = {
    id: conversationId,
    leadId,
    senderId,
    messages,
    drafts: [],
    status: 'active',
    workspaceId: wsModule.getId(),
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

function getAllConversations(workspaceId) {
  let all = [...conversations.values()];
  if (workspaceId) all = all.filter(c => c.workspaceId === workspaceId);
  return all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
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
  const wsModule = require('./workspace');
  const action = {
    id: uuidv4(),
    type,
    leadId:         leadId || '',
    conversationId: conversationId || '',
    data,
    result,
    workspaceId:    wsModule.getId(),
    timestamp: new Date().toISOString(),
  };
  actions.push(action);
  syncAction(action);
}

function getActionLog(limit = 100, workspaceId) {
  let filtered = workspaceId ? actions.filter(a => a.workspaceId === workspaceId) : actions;
  return filtered.slice(-limit).reverse();
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

function getAnalytics(workspaceId) {
  const allLeads = getAllLeads(workspaceId);

  const stageCount = allLeads.reduce((acc, l) => {
    acc[l.stage] = (acc[l.stage] || 0) + 1;
    return acc;
  }, {});

  const funnelStageCount = allLeads.reduce((acc, l) => {
    const fs = l.funnelStage || 'cold_opener';
    acc[fs] = (acc[fs] || 0) + 1;
    return acc;
  }, {});

  const wsActions = workspaceId ? actions.filter(a => a.workspaceId === workspaceId) : actions;
  const sentActions = wsActions.filter(a => a.type === 'message_sent');

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
    humanTakeovers:         wsActions.filter(a => a.type === 'human_takeover').length,
    trialStarts,
    totalCreditsUsed,
    conversionByRoute,
    totalLeadsByRoute,
    conversionByFunnelStage,
    actionsToday:           wsActions.filter(a => new Date(a.timestamp).toDateString() === today).length,
  };
}

// ---- TRAINING PREFERENCES ----

// Awaits the Airtable create so the returned pref object has its real airtableId.
// Callers that don't await still get the synchronous in-memory push (the array push
// + scenario count increment happen at the top, before the await). Critical for the
// avatar matrix POST endpoint, which returns the pref to the dashboard immediately —
// without the airtableId, edit/delete/canonical-toggle break on the freshly-added row.
async function addTrainingPreference(pref) {
  const workspace = require('./workspace');
  pref.workspaceId = workspace.getId();
  pref.source = pref.source || 'training';
  // Sanitize thread once at the entry point — strips dashboard-only metadata
  // (breakdown, avatarId, etc.) so the stored thread stays small enough for
  // Airtable's 100K Long text limit. Done here so every downstream consumer
  // (in-memory store, Airtable write, local backup file) sees the slim form.
  if (pref.thread) pref.thread = sanitizeThread(pref.thread);
  trainingPreferences.push(pref);
  _incrementScenarioCount(pref.workspaceId, pref.scenario);

  // Local JSON backup FIRST. This guarantees the record survives any restart
  // regardless of Airtable's state — losing a machine means losing nothing.
  appendTrainingBackup(pref);

  const b = getBase();
  if (b) {
    try {
      const rec = await b(TABLES.training).create([{ fields: {
        Type:         pref.type || 'draft',
        Scenario:     safeStr(pref.scenario),
        Chosen:       safeStr(pref.chosen),
        Original:     safeStr(pref.original || ''),
        SelectedText: safeStr(pref.selectedText || ''),
        Feedback:     safeStr(pref.feedback || ''),
        Rating:       pref.rating || '',
        Thread:       safeStr(pref.thread || []),
        Question:     safeStr(pref.question || ''),
        OptionIndex:  pref.optionIndex ?? -1,
        IsCustom:     !!pref.isCustom,
        Avatar:       pref.avatar || '',
        IsCanonical:  !!pref.isCanonical,
        Timestamp:    pref.timestamp,
        WorkspaceId:  pref.workspaceId,
        Source:       pref.source,
      }}]);
      if (rec && rec[0]) pref.airtableId = rec[0].id;
    } catch (err) {
      // Don't throw — keep the in-memory + local-file record. The local backup
      // means we can re-push later. But DO surface so the dashboard can warn.
      pref._airtableError = err.message;
      console.warn('[Store] Airtable training sync failed (record kept locally):', err.message);
      // Auto-retry the resync after a short delay. Handles the common case of
      // transient rate-limits or network blips — the user shouldn't have to
      // click anything for these to recover. If retries keep failing, the
      // dashboard banner stays up and the user can intervene manually.
      _scheduleAutoResync();
    }
  } else {
    // No Airtable configured on this machine. The local file is the only
    // store; user must run forceResyncTrainingToAirtable() from a machine
    // with credentials to push these into Airtable when convenient.
    pref._airtableError = 'No AIRTABLE_API_KEY on this machine — record saved locally only';
  }

  // Auto-trigger voice DNA refresh (fire-and-forget — never blocks the caller)
  try {
    const voiceDna = require('./voice-dna');
    voiceDna.maybeRegenerate(pref.workspaceId).catch(err =>
      console.warn('[Store] voice-dna auto-regen failed:', err.message)
    );
  } catch (err) {
    // voice-dna service not loaded yet — first call will load it
  }
  return pref;
}

function getTrainingPreferences(workspaceId) {
  if (workspaceId) return trainingPreferences.filter(p => p.workspaceId === workspaceId);
  return trainingPreferences;
}

function getTrainingByAvatar(workspaceId, avatarId) {
  return trainingPreferences.filter(p => p.workspaceId === workspaceId && p.avatar === avatarId);
}

// Hard-delete a training record from Airtable + the in-memory store.
// Used when the user marks an example as wrong/stale via the avatar browser.
async function deleteTrainingPreference(airtableId) {
  const idx = trainingPreferences.findIndex(p => p.airtableId === airtableId);
  let removed = null;
  if (idx >= 0) {
    [removed] = trainingPreferences.splice(idx, 1);
  }
  const b = getBase();
  if (b && airtableId) {
    try { await b(TABLES.training).destroy(airtableId); }
    catch (err) { console.warn('[Store] Airtable training delete failed:', err.message); }
  }
  return removed;
}

// Update fields on an existing training record. Supports avatar/canonical metadata
// AND the message-content fields (chosen, original, feedback, selectedText, rating).
// Used by migration, the canonical toggle, and the avatar browser's inline editor.
async function updateTrainingFields(airtableId, fields) {
  const pref = trainingPreferences.find(p => p.airtableId === airtableId);
  if (pref) {
    if ('avatar'       in fields) pref.avatar       = fields.avatar;
    if ('isCanonical'  in fields) pref.isCanonical  = !!fields.isCanonical;
    if ('chosen'       in fields) pref.chosen       = fields.chosen;
    if ('original'     in fields) pref.original     = fields.original;
    if ('feedback'     in fields) pref.feedback     = fields.feedback;
    if ('selectedText' in fields) pref.selectedText = fields.selectedText;
    if ('rating'       in fields) pref.rating       = fields.rating;
    if ('question'     in fields) pref.question     = fields.question;
  }
  const b = getBase();
  if (!b || !airtableId) return pref || null;
  try {
    const atFields = {};
    if ('avatar'       in fields) atFields.Avatar       = fields.avatar;
    if ('isCanonical'  in fields) atFields.IsCanonical  = !!fields.isCanonical;
    if ('chosen'       in fields) atFields.Chosen       = fields.chosen;
    if ('original'     in fields) atFields.Original     = fields.original;
    if ('feedback'     in fields) atFields.Feedback     = fields.feedback;
    if ('selectedText' in fields) atFields.SelectedText = fields.selectedText;
    if ('rating'       in fields) atFields.Rating       = fields.rating;
    if ('question'     in fields) atFields.Question     = fields.question;
    await b(TABLES.training).update(airtableId, atFields);
  } catch (err) {
    console.warn('[Store] Airtable training update failed:', err.message);
  }
  return pref || null;
}

function clearTrainingPreferences() {
  const workspace = require('./workspace');
  const wsId = workspace.getId();
  // Only clear this workspace's data
  for (let i = trainingPreferences.length - 1; i >= 0; i--) {
    if (trainingPreferences[i].workspaceId === wsId) {
      trainingPreferences.splice(i, 1);
    }
  }
  scenarioCounts.delete(wsId);
}

// ---- MESSAGE RATINGS ----

const messageRatings = [];

function addMessageRating(rating) {
  const workspace = require('./workspace');
  rating.workspaceId = workspace.getId();
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
      WasAutoSent: !!rating.wasAutoSent,
      Timestamp: rating.timestamp,
      WorkspaceId: rating.workspaceId,
    }}]).catch(err => console.warn('[Store] Airtable rating sync failed:', err.message));
  }
}

function getMessageRatings(workspaceId) {
  if (workspaceId) return messageRatings.filter(r => r.workspaceId === workspaceId);
  return messageRatings;
}

// Load training data from Airtable on startup, then replay any local-only
// records from the JSONL backup file. The replay is keyed on (timestamp +
// chosen-text-hash) so we don't duplicate records that DID make it to Airtable.
async function loadTraining() {
  const b = getBase();
  if (b) {
    try {
      // No maxRecords cap — Airtable's .all() handles pagination internally and
      // returns every row. Earlier we capped at 500, which silently dropped any
      // records past that threshold on each restart (newest-first lost when
      // sorted ASC). Sort DESC so if we ever do hit a cap (Airtable's hard
      // limit), the OLDEST get dropped instead of the freshest training.
      const records = await b(TABLES.training).select({ sort: [{ field: 'Timestamp', direction: 'desc' }] }).all();
      for (const r of records) {
        let scenario;
        try { scenario = JSON.parse(r.get('Scenario') || '{}'); } catch { scenario = {}; }
        let loadedThread = [];
        try { loadedThread = JSON.parse(r.get('Thread') || '[]'); } catch { loadedThread = []; }
        const loadedPref = {
          type: r.get('Type') || 'draft',
          scenario,
          chosen:       r.get('Chosen') || '',
          original:     r.get('Original') || '',
          selectedText: r.get('SelectedText') || '',
          feedback:     r.get('Feedback') || '',
          rating:       r.get('Rating') || '',
          thread:       loadedThread,
          question:     r.get('Question') || '',
          optionIndex:  r.get('OptionIndex') ?? -1,
          isCustom:     !!r.get('IsCustom'),
          avatar:       r.get('Avatar') || '',
          isCanonical:  !!r.get('IsCanonical'),
          timestamp:    r.get('Timestamp') || '',
          workspaceId:  r.get('WorkspaceId') || 'infeed',
          source:       r.get('Source') || 'training',
          airtableId:   r.id,
        };
        trainingPreferences.push(loadedPref);
        _incrementScenarioCount(loadedPref.workspaceId, loadedPref.scenario);
      }
      console.log(`[Store] Loaded ${trainingPreferences.length} training preferences from Airtable`);
    } catch (err) {
      console.warn('[Store] Could not load training data from Airtable:', err.message);
    }
  } else {
    console.log('[Store] No Airtable configured — loading training from local backup only');
  }

  // Replay local backup. Identity = timestamp + first 80 chars of chosen.
  // Anything in the local file that has no matching Airtable record gets
  // re-loaded into memory.
  const recordKey = (p) => `${p.timestamp || ''}__${(p.chosen || '').slice(0, 80)}`;
  const seen = new Set(trainingPreferences.map(recordKey));
  const localRecords = readTrainingBackup();
  let replayed = 0;
  for (const local of localRecords) {
    const key = recordKey(local);
    if (seen.has(key)) continue;
    seen.add(key);
    // Critical: drop airtableId from the replayed copy. The id from the laptop
    // that wrote the backup may not exist in THIS server's Airtable base, or
    // may not be valid here. Treating it as untagged forces the auto-resync
    // below to re-create the row, which gives us a real id we can use.
    local.airtableId = undefined;
    trainingPreferences.push(local);
    _incrementScenarioCount(local.workspaceId, local.scenario);
    replayed++;
  }
  if (replayed > 0) {
    console.log(`[Store] Replayed ${replayed} local-only training records from backup file.`);
  }

  // Auto-resync at startup: if Airtable is configured AND we have any in-memory
  // records without an airtableId (replayed from backup, or carried over from
  // a previous run where Airtable was down), push them up immediately. This
  // closes the loop on multi-machine workflows: train on a machine without
  // creds → iCloud syncs the backup file → next time the machine WITH creds
  // boots, the records auto-land in Airtable. No "Resync now" click required.
  if (b) {
    const pendingCount = trainingPreferences.filter(p => !p.airtableId).length;
    if (pendingCount > 0) {
      console.log(`[Store] Auto-resyncing ${pendingCount} pending training records to Airtable…`);
      // Don't await — let the server come up, do this in the background. The
      // dashboard's pending-sync banner will reflect the live count as it works.
      forceResyncTrainingToAirtable()
        .then(r => console.log(`[Store] Auto-resync done: pushed ${r.pushed}, failed ${r.failed} of ${r.totalPending}`))
        .catch(err => console.warn('[Store] Auto-resync failed:', err.message));
    }
  }
}

// Push every in-memory training record that lacks an airtableId up to
// Airtable. Used to recover from machine-portability gaps: train on a laptop
// without credentials, then sync from a machine that has them — or recover
// after Airtable rate-limits / outages drop a batch of writes.
async function forceResyncTrainingToAirtable() {
  const b = getBase();
  if (!b) return { pushed: 0, failed: 0, error: 'No AIRTABLE_API_KEY configured on this machine' };
  const pending = trainingPreferences.filter(p => !p.airtableId);
  let pushed = 0;
  let failed = 0;
  const errors = [];
  // Batch by 10 (Airtable allows up to 10 records per create call).
  for (let i = 0; i < pending.length; i += 10) {
    const batch = pending.slice(i, i + 10);
    try {
      // Sanitize thread defensively — older pending records that pre-date the
      // entry-point sanitization in addTrainingPreference may still carry the
      // bloated dashboard metadata. Stripping here lets the resync rescue them.
      for (const p of batch) {
        if (p.thread) p.thread = sanitizeThread(p.thread);
      }
      const recs = await b(TABLES.training).create(batch.map(pref => ({ fields: {
        Type:         pref.type || 'draft',
        Scenario:     safeStr(pref.scenario),
        Chosen:       safeStr(pref.chosen),
        Original:     safeStr(pref.original || ''),
        SelectedText: safeStr(pref.selectedText || ''),
        Feedback:     safeStr(pref.feedback || ''),
        Rating:       pref.rating || '',
        Thread:       safeStr(pref.thread || []),
        Question:     safeStr(pref.question || ''),
        OptionIndex:  pref.optionIndex ?? -1,
        IsCustom:     !!pref.isCustom,
        Avatar:       pref.avatar || '',
        IsCanonical:  !!pref.isCanonical,
        Timestamp:    pref.timestamp,
        WorkspaceId:  pref.workspaceId,
        Source:       pref.source,
      }})));
      for (let j = 0; j < batch.length; j++) {
        if (recs[j]) {
          batch[j].airtableId = recs[j].id;
          delete batch[j]._airtableError;
          pushed++;
        }
      }
    } catch (err) {
      failed += batch.length;
      errors.push(err.message);
      // Mark the batch with the error so the dashboard can surface
      for (const p of batch) p._airtableError = err.message;
    }
  }
  return { pushed, failed, totalPending: pending.length, errors: errors.slice(0, 5) };
}

function getPendingTrainingSyncCount() {
  return trainingPreferences.filter(p => !p.airtableId).length;
}

// Debounced auto-resync: scheduled after a save fails. Coalesces bursts of
// failures into one resync run 30s later, so transient Airtable rate-limits
// recover on their own without the user clicking anything. Also re-arms on
// every failure inside the window, so a long outage doesn't trigger 100
// concurrent retries.
let _autoResyncTimer = null;
function _scheduleAutoResync() {
  if (_autoResyncTimer) clearTimeout(_autoResyncTimer);
  _autoResyncTimer = setTimeout(async () => {
    _autoResyncTimer = null;
    const pending = getPendingTrainingSyncCount();
    if (pending === 0) return;
    try {
      const r = await forceResyncTrainingToAirtable();
      console.log(`[Store] Auto-retry resync: pushed ${r.pushed}, failed ${r.failed} of ${r.totalPending}`);
      // If anything still failed, re-schedule with a longer backoff
      if (r.failed > 0) {
        setTimeout(() => _scheduleAutoResync(), 60_000);
      }
    } catch (err) {
      console.warn('[Store] Auto-retry resync failed:', err.message);
      setTimeout(() => _scheduleAutoResync(), 60_000);
    }
  }, 30_000);
}

module.exports = {
  init,
  upsertLead,
  updateLeadStage,
  updateLeadNotes,
  getLeadByUrl,
  getLead,
  getAllLeads,
  deleteLead,
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
  getTrainingByAvatar,
  updateTrainingFields,
  deleteTrainingPreference,
  clearTrainingPreferences,
  getScenarioCount,
  getScenarioCountsForWorkspace,
  addMessageRating,
  getMessageRatings,
  loadTraining,
  forceResyncTrainingToAirtable,
  getPendingTrainingSyncCount,
  resetAirtableClient,
};
