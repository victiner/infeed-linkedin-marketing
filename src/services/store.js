// src/services/store.js
// Postgres-backed store with in-memory cache.
//
// Replaces the prior Airtable backing store. Schema lives in src/db/schema.sql
// and is auto-applied on startup. All write operations update the in-memory
// cache synchronously and persist to Postgres in the background — callers
// never wait on the DB.
//
// Backward compat: every record still has an `airtableId` field (set to the
// same value as `id`) so older callers that key on `airtableId` keep working
// without changes.

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const db = require('../db');

// ---- LOCAL TRAINING BACKUP -------------------------------------------------
// Every training preference is also written to a local JSON file. This means:
//   1. If Postgres is unavailable, the record still survives a server restart.
//   2. On startup, after loading from Postgres, we replay any local-only
//      records so the in-memory store has everything you ever trained,
//      regardless of which machine.
//   3. forceResyncTrainingToAirtable() (legacy export name) re-pushes any
//      in-memory records missing an id to Postgres when it recovers.
const TRAINING_BACKUP_PATH = path.join(__dirname, '..', '..', 'data', 'training-backup.jsonl');
function ensureBackupDir() {
  try { fs.mkdirSync(path.dirname(TRAINING_BACKUP_PATH), { recursive: true }); } catch {}
}
function appendTrainingBackup(pref) {
  try {
    ensureBackupDir();
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

// In-memory cache
const leads         = new Map(); // leadId → lead
const conversations = new Map(); // conversationId → conversation
const actions       = [];        // append-only
const trainingPreferences = [];  // recorded user style choices
const messageRatings      = [];

// Write-time index: Map<workspaceId, Map<scenarioKey, count>>
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

// Strip dashboard-only metadata from a thread before serializing it for
// storage. Without this, sim-thread messages carry their full guidance
// breakdown on each turn, ballooning the JSON.
function sanitizeThread(thread) {
  if (!Array.isArray(thread)) return [];
  return thread
    .filter(m => m && typeof m.sender === 'string' && typeof m.text === 'string')
    .map(m => {
      const out = { sender: m.sender, text: m.text };
      if (m._synthesized) out._synthesized = true;
      if (m._ghost) out._ghost = true;
      if (m._followUp) out._followUp = true;
      if (m._edited) out._edited = true;
      if (m.original && typeof m.original === 'string') out.original = m.original;
      return out;
    });
}

// ---- POSTGRES SYNC HELPERS (fire-and-forget) ----

async function syncLead(lead) {
  if (!db.isConfigured()) return;
  try {
    await db.query(`
      INSERT INTO leads (
        id, linkedin_url, name, role, company, sender_id, tags, stage,
        funnel_stage, sentiment, last_routing_decision, last_asset_sent,
        credits_used, credits_total, trial_started, trial_expired,
        call_booked, converted, campaign_id, current_step_index,
        last_step_at, notes, notes_updated_at, workspace_id,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8,
        $9, $10, $11::jsonb, $12,
        $13, $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22::jsonb, $23, $24,
        $25, $26
      )
      ON CONFLICT (id) DO UPDATE SET
        linkedin_url = EXCLUDED.linkedin_url,
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        company = EXCLUDED.company,
        sender_id = EXCLUDED.sender_id,
        tags = EXCLUDED.tags,
        stage = EXCLUDED.stage,
        funnel_stage = EXCLUDED.funnel_stage,
        sentiment = EXCLUDED.sentiment,
        last_routing_decision = EXCLUDED.last_routing_decision,
        last_asset_sent = EXCLUDED.last_asset_sent,
        credits_used = EXCLUDED.credits_used,
        credits_total = EXCLUDED.credits_total,
        trial_started = EXCLUDED.trial_started,
        trial_expired = EXCLUDED.trial_expired,
        call_booked = EXCLUDED.call_booked,
        converted = EXCLUDED.converted,
        campaign_id = EXCLUDED.campaign_id,
        current_step_index = EXCLUDED.current_step_index,
        last_step_at = EXCLUDED.last_step_at,
        notes = EXCLUDED.notes,
        notes_updated_at = EXCLUDED.notes_updated_at,
        updated_at = EXCLUDED.updated_at
    `, [
      lead.id, lead.linkedInUrl || '', lead.name || '', lead.role || '',
      lead.company || '', lead.senderId || '', JSON.stringify(lead.tags || []),
      lead.stage || 'cold', lead.funnelStage || 'cold_opener',
      lead.sentiment || 'neutral', JSON.stringify(lead.lastRoutingDecision || null),
      lead.lastAssetSent || null, lead.creditsUsed || 0, lead.creditsTotal || 20,
      !!lead.trialStarted, !!lead.trialExpired, !!lead.callBooked, !!lead.converted,
      lead.campaignId || null, lead.currentStepIndex || 0, lead.lastStepAt || null,
      JSON.stringify(lead.notes || {}), lead.notesUpdatedAt || null,
      lead.workspaceId || 'infeed',
      lead.createdAt || new Date().toISOString(),
      lead.updatedAt || new Date().toISOString(),
    ]);
  } catch (err) {
    console.warn('[Store] Postgres lead sync failed:', err.message);
  }
}

async function syncConversation(convo) {
  if (!db.isConfigured()) return;
  try {
    await db.query(`
      INSERT INTO conversations (
        id, lead_id, sender_id, messages, drafts, status,
        workspace_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        lead_id = EXCLUDED.lead_id,
        sender_id = EXCLUDED.sender_id,
        messages = EXCLUDED.messages,
        drafts = EXCLUDED.drafts,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
    `, [
      convo.id, convo.leadId || null, convo.senderId || null,
      JSON.stringify(convo.messages || []),
      JSON.stringify(convo.drafts || []),
      convo.status || 'active',
      convo.workspaceId || 'infeed',
      convo.createdAt || new Date().toISOString(),
      convo.updatedAt || new Date().toISOString(),
    ]);
  } catch (err) {
    console.warn('[Store] Postgres conversation sync failed:', err.message);
  }
}

async function syncAction(action) {
  if (!db.isConfigured()) return;
  try {
    await db.query(`
      INSERT INTO actions (id, type, lead_id, conversation_id, data, result, workspace_id, timestamp)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      ON CONFLICT (id) DO NOTHING
    `, [
      action.id, action.type || '', action.leadId || null, action.conversationId || null,
      JSON.stringify(action.data || {}),
      typeof action.result === 'string' ? action.result : JSON.stringify(action.result || ''),
      action.workspaceId || 'infeed',
      action.timestamp || new Date().toISOString(),
    ]);
  } catch (err) {
    console.warn('[Store] Postgres action sync failed:', err.message);
  }
}

// ---- STARTUP: load from Postgres ----

async function init() {
  if (!db.isConfigured()) {
    console.log('[Store] DATABASE_URL not set — using in-memory store only (data will be lost on restart)');
    return;
  }
  console.log('[Store] Loading data from Postgres...');

  try {
    const { rows } = await db.query(`SELECT * FROM leads ORDER BY updated_at DESC`);
    for (const r of rows) {
      const lead = {
        id:                   r.id,
        linkedInUrl:          r.linkedin_url || '',
        name:                 r.name || '',
        role:                 r.role || '',
        company:              r.company || '',
        senderId:             r.sender_id || '',
        tags:                 r.tags || [],
        stage:                r.stage || 'cold',
        funnelStage:          r.funnel_stage || 'cold_opener',
        sentiment:            r.sentiment || 'neutral',
        lastRoutingDecision:  r.last_routing_decision || null,
        lastAssetSent:        r.last_asset_sent || null,
        creditsUsed:          r.credits_used || 0,
        creditsTotal:         r.credits_total || 20,
        trialStarted:         !!r.trial_started,
        trialExpired:         !!r.trial_expired,
        callBooked:           !!r.call_booked,
        converted:            !!r.converted,
        campaignId:           r.campaign_id || null,
        currentStepIndex:     r.current_step_index || 0,
        lastStepAt:           r.last_step_at ? new Date(r.last_step_at).toISOString() : null,
        notes:                r.notes || {},
        notesUpdatedAt:       r.notes_updated_at ? new Date(r.notes_updated_at).toISOString() : null,
        workspaceId:          r.workspace_id || 'infeed',
        createdAt:            r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        updatedAt:            r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
      };
      leads.set(lead.id, lead);
    }
    console.log(`[Store] Loaded ${leads.size} leads`);
  } catch (err) {
    console.warn('[Store] Could not load leads from Postgres:', err.message);
  }

  try {
    const { rows } = await db.query(`SELECT * FROM conversations ORDER BY updated_at DESC`);
    for (const r of rows) {
      const convo = {
        id:          r.id,
        leadId:      r.lead_id || '',
        senderId:    r.sender_id || '',
        messages:    r.messages || [],
        drafts:      r.drafts || [],
        status:      r.status || 'active',
        workspaceId: r.workspace_id || 'infeed',
        createdAt:   r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        updatedAt:   r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
      };
      conversations.set(convo.id, convo);
    }
    console.log(`[Store] Loaded ${conversations.size} conversations`);
  } catch (err) {
    console.warn('[Store] Could not load conversations from Postgres:', err.message);
  }

  try {
    const { rows } = await db.query(`SELECT * FROM actions ORDER BY timestamp ASC`);
    for (const r of rows) {
      actions.push({
        id:             r.id,
        type:           r.type || '',
        leadId:         r.lead_id || '',
        conversationId: r.conversation_id || '',
        data:           r.data || {},
        result:         r.result || '',
        workspaceId:    r.workspace_id || 'infeed',
        timestamp:      r.timestamp ? new Date(r.timestamp).toISOString() : new Date().toISOString(),
      });
    }
    console.log(`[Store] Loaded ${actions.length} actions`);
  } catch (err) {
    console.warn('[Store] Could not load actions from Postgres:', err.message);
  }

  try {
    const { rows } = await db.query(`SELECT * FROM ratings`);
    for (const r of rows) {
      messageRatings.push({
        id:             r.id,
        conversationId: r.conversation_id || '',
        leadName:       r.lead_name || '',
        messageText:    r.message_text || '',
        rating:         r.rating || '',
        category:       r.category || '',
        feedback:       r.feedback || '',
        wasAutoSent:    !!r.was_auto_sent,
        workspaceId:    r.workspace_id || 'infeed',
        timestamp:      r.timestamp ? new Date(r.timestamp).toISOString() : new Date().toISOString(),
      });
    }
    console.log(`[Store] Loaded ${messageRatings.length} message ratings`);
  } catch (err) {
    console.warn('[Store] Could not load ratings from Postgres:', err.message);
  }
}

// ---- LEAD OPERATIONS ----

function upsertLead({ linkedInUrl, name, role, company, senderId, tags = [], notes = {}, about = '' }) {
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

// Delete a lead + cascade conversations and actions.
async function deleteLead(leadId) {
  const lead = leads.get(leadId);
  if (!lead) return { deleted: false, reason: 'not_found' };

  const relatedConvos = [...conversations.values()].filter(c => c.leadId === leadId);

  if (db.isConfigured()) {
    try {
      await db.query(`DELETE FROM conversations WHERE lead_id = $1`, [leadId]);
      await db.query(`DELETE FROM actions WHERE lead_id = $1`, [leadId]);
      await db.query(`DELETE FROM leads WHERE id = $1`, [leadId]);
    } catch (err) {
      console.warn('[Store] Postgres deleteLead cascade failed:', err.message);
    }
  }

  for (const convo of relatedConvos) {
    conversations.delete(convo.id);
  }
  leads.delete(leadId);

  // Remove related actions from in-memory log
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].leadId === leadId) actions.splice(i, 1);
  }

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

// Append an outbound message to a conversation's messages[] so it shows in the
// Conversations panel. Dedupes if an identical message was just appended.
function appendOutboundMessage(conversationId, text, { status = 'sent', timestamp } = {}) {
  const convo = conversations.get(conversationId);
  if (!convo) return null;
  const ts = timestamp || new Date().toISOString();
  const sixtySecAgo = Date.now() - 60_000;
  const exists = convo.messages.some(m =>
    m.sender === 'us' && m.text === text && new Date(m.timestamp).getTime() > sixtySecAgo
  );
  if (exists) return convo;
  convo.messages.push({ sender: 'us', text, timestamp: ts, status });
  convo.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  convo.updatedAt = new Date().toISOString();
  conversations.set(conversationId, convo);
  syncConversation(convo);
  return convo;
}

function updateOutboundMessageStatus(conversationId, text, newStatus) {
  const convo = conversations.get(conversationId);
  if (!convo) return null;
  for (let i = convo.messages.length - 1; i >= 0; i--) {
    const m = convo.messages[i];
    if (m.sender === 'us' && m.text === text) {
      m.status = newStatus;
      convo.updatedAt = new Date().toISOString();
      conversations.set(conversationId, convo);
      syncConversation(convo);
      return convo;
    }
  }
  return convo;
}

// Replace messages[] from a HeyReach thread fetch. Preserves local queued
// outbound messages that HeyReach hasn't dispatched yet.
function replaceMessages(conversationId, messages) {
  const convo = conversations.get(conversationId);
  if (!convo) return null;

  const fromHeyReach = messages.map(m =>
    m.sender === 'us' ? { ...m, status: 'sent' } : m
  );

  const hrUsTexts = new Set(messages.filter(m => m.sender === 'us').map(m => m.text));
  const preservedQueued = convo.messages.filter(m =>
    m.sender === 'us' && m.status === 'queued' && !hrUsTexts.has(m.text)
  );

  convo.messages = [...fromHeyReach, ...preservedQueued]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  convo.lastSyncedAt = new Date().toISOString();
  convo.updatedAt = new Date().toISOString();
  conversations.set(conversationId, convo);
  syncConversation(convo);
  return convo;
}

async function deleteConversation(conversationId) {
  const convo = conversations.get(conversationId);
  if (!convo) return false;
  if (db.isConfigured()) {
    try { await db.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]); }
    catch (err) { console.warn(`[Store] Postgres deleteConversation failed for ${conversationId}:`, err.message); }
  }
  conversations.delete(conversationId);
  return true;
}

// Merge a synthetic conversation (e.g. `import-${leadId}`) into a real HeyReach
// conversation ID. Ports messages + drafts, then deletes synth.
function mergeConversations(synthId, realId, { leadId, senderId } = {}) {
  if (synthId === realId) return conversations.get(realId) || null;
  const synth = conversations.get(synthId);
  if (!synth) return conversations.get(realId) || null;

  let real = conversations.get(realId);
  if (!real) {
    const wsModule = require('./workspace');
    real = {
      id: realId,
      leadId: leadId || synth.leadId,
      senderId: senderId || synth.senderId,
      messages: [...synth.messages],
      drafts: [...synth.drafts],
      status: synth.status || 'active',
      workspaceId: synth.workspaceId || wsModule.getId(),
      createdAt: synth.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    conversations.set(realId, real);
  } else {
    const existingKeys = new Set(real.messages.map(m => `${m.sender}-${m.text}-${m.timestamp}`));
    for (const m of synth.messages) {
      const key = `${m.sender}-${m.text}-${m.timestamp}`;
      if (!existingKeys.has(key)) real.messages.push(m);
    }
    real.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const realDraftKeys = new Set(real.drafts.map(d => d.text));
    for (const d of synth.drafts) {
      if (!realDraftKeys.has(d.text)) real.drafts.push(d);
    }

    real.updatedAt = new Date().toISOString();
    conversations.set(realId, real);
  }
  syncConversation(real);

  for (const a of actions) {
    if (a.conversationId === synthId) a.conversationId = realId;
  }

  deleteConversation(synthId).catch(err =>
    console.warn(`[Store] Failed to delete synth conv ${synthId}:`, err.message)
  );

  console.log(`[Store] Merged conv ${synthId} → ${realId} (${real.messages.length} msgs, ${real.drafts.length} drafts)`);
  return real;
}

function findSyntheticConversationForLead(leadId) {
  return [...conversations.values()].find(c => c.leadId === leadId && c.id.startsWith('import-')) || null;
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

  const leadRoutesMap = {};
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

async function addTrainingPreference(pref) {
  const workspace = require('./workspace');
  pref.workspaceId = workspace.getId();
  pref.source = pref.source || 'training';
  if (pref.thread) pref.thread = sanitizeThread(pref.thread);
  pref.id = pref.id || uuidv4();
  pref.airtableId = pref.id; // back-compat alias
  pref.timestamp = pref.timestamp || new Date().toISOString();

  trainingPreferences.push(pref);
  _incrementScenarioCount(pref.workspaceId, pref.scenario);

  // Local JSON backup FIRST — survives any restart regardless of DB state.
  appendTrainingBackup(pref);

  if (db.isConfigured()) {
    try {
      await db.query(`
        INSERT INTO training (
          id, type, scenario, chosen, original, selected_text, feedback,
          rating, thread, question, option_index, is_custom, avatar,
          is_canonical, source, workspace_id, timestamp
        ) VALUES (
          $1, $2, $3::jsonb, $4, $5, $6, $7,
          $8, $9::jsonb, $10, $11, $12, $13,
          $14, $15, $16, $17
        )
        ON CONFLICT (id) DO NOTHING
      `, [
        pref.id, pref.type || 'draft',
        JSON.stringify(pref.scenario || {}),
        pref.chosen || '', pref.original || '', pref.selectedText || '',
        pref.feedback || '', pref.rating || '',
        JSON.stringify(pref.thread || []),
        pref.question || '', pref.optionIndex ?? -1, !!pref.isCustom,
        pref.avatar || '', !!pref.isCanonical,
        pref.source, pref.workspaceId, pref.timestamp,
      ]);
    } catch (err) {
      pref._airtableError = err.message;
      console.warn('[Store] Postgres training sync failed (record kept locally):', err.message);
      _scheduleAutoResync();
    }
  } else {
    pref._airtableError = 'DATABASE_URL not configured on this machine — record saved locally only';
  }

  try {
    const voiceDna = require('./voice-dna');
    voiceDna.maybeRegenerate(pref.workspaceId).catch(err =>
      console.warn('[Store] voice-dna auto-regen failed:', err.message)
    );
  } catch (err) {}
  return pref;
}

function getTrainingPreferences(workspaceId) {
  if (workspaceId) return trainingPreferences.filter(p => p.workspaceId === workspaceId);
  return trainingPreferences;
}

function getTrainingByAvatar(workspaceId, avatarId) {
  return trainingPreferences.filter(p => p.workspaceId === workspaceId && p.avatar === avatarId);
}

async function deleteTrainingPreference(prefId) {
  const idx = trainingPreferences.findIndex(p => p.airtableId === prefId || p.id === prefId);
  let removed = null;
  if (idx >= 0) {
    [removed] = trainingPreferences.splice(idx, 1);
  }
  if (db.isConfigured() && prefId) {
    try { await db.query(`DELETE FROM training WHERE id = $1`, [prefId]); }
    catch (err) { console.warn('[Store] Postgres training delete failed:', err.message); }
  }
  return removed;
}

async function updateTrainingFields(prefId, fields) {
  const pref = trainingPreferences.find(p => p.airtableId === prefId || p.id === prefId);
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
  if (!db.isConfigured() || !prefId) return pref || null;

  const setClauses = [];
  const params = [];
  let i = 1;
  if ('avatar'       in fields) { setClauses.push(`avatar = $${i++}`);       params.push(fields.avatar); }
  if ('isCanonical'  in fields) { setClauses.push(`is_canonical = $${i++}`); params.push(!!fields.isCanonical); }
  if ('chosen'       in fields) { setClauses.push(`chosen = $${i++}`);       params.push(fields.chosen); }
  if ('original'     in fields) { setClauses.push(`original = $${i++}`);     params.push(fields.original); }
  if ('feedback'     in fields) { setClauses.push(`feedback = $${i++}`);     params.push(fields.feedback); }
  if ('selectedText' in fields) { setClauses.push(`selected_text = $${i++}`); params.push(fields.selectedText); }
  if ('rating'       in fields) { setClauses.push(`rating = $${i++}`);       params.push(fields.rating); }
  if ('question'     in fields) { setClauses.push(`question = $${i++}`);     params.push(fields.question); }

  if (setClauses.length === 0) return pref || null;
  params.push(prefId);
  try {
    await db.query(`UPDATE training SET ${setClauses.join(', ')} WHERE id = $${i}`, params);
  } catch (err) {
    console.warn('[Store] Postgres training update failed:', err.message);
  }
  return pref || null;
}

function clearTrainingPreferences() {
  const workspace = require('./workspace');
  const wsId = workspace.getId();
  for (let i = trainingPreferences.length - 1; i >= 0; i--) {
    if (trainingPreferences[i].workspaceId === wsId) {
      trainingPreferences.splice(i, 1);
    }
  }
  scenarioCounts.delete(wsId);
}

// ---- MESSAGE RATINGS ----

function addMessageRating(rating) {
  const workspace = require('./workspace');
  rating.workspaceId = workspace.getId();
  rating.id = rating.id || uuidv4();
  rating.timestamp = rating.timestamp || new Date().toISOString();
  messageRatings.push(rating);

  if (db.isConfigured()) {
    db.query(`
      INSERT INTO ratings (id, conversation_id, lead_name, message_text, rating, category, feedback, was_auto_sent, workspace_id, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING
    `, [
      rating.id, rating.conversationId || null, rating.leadName || '',
      rating.messageText || '', rating.rating || '', rating.category || '',
      rating.feedback || '', !!rating.wasAutoSent, rating.workspaceId,
      rating.timestamp,
    ]).catch(err => console.warn('[Store] Postgres rating sync failed:', err.message));
  }
}

function getMessageRatings(workspaceId) {
  if (workspaceId) return messageRatings.filter(r => r.workspaceId === workspaceId);
  return messageRatings;
}

// Load training from Postgres on startup, then replay any local-only JSONL
// records (records on this machine that never made it to the DB).
async function loadTraining() {
  if (db.isConfigured()) {
    try {
      const { rows } = await db.query(`SELECT * FROM training ORDER BY timestamp DESC`);
      for (const r of rows) {
        const loadedPref = {
          id:           r.id,
          airtableId:   r.id, // back-compat
          type:         r.type || 'draft',
          scenario:     r.scenario || {},
          chosen:       r.chosen || '',
          original:     r.original || '',
          selectedText: r.selected_text || '',
          feedback:     r.feedback || '',
          rating:       r.rating || '',
          thread:       r.thread || [],
          question:     r.question || '',
          optionIndex:  r.option_index ?? -1,
          isCustom:     !!r.is_custom,
          avatar:       r.avatar || '',
          isCanonical:  !!r.is_canonical,
          source:       r.source || 'training',
          workspaceId:  r.workspace_id || 'infeed',
          timestamp:    r.timestamp ? new Date(r.timestamp).toISOString() : '',
        };
        trainingPreferences.push(loadedPref);
        _incrementScenarioCount(loadedPref.workspaceId, loadedPref.scenario);
      }
      console.log(`[Store] Loaded ${trainingPreferences.length} training preferences from Postgres`);
    } catch (err) {
      console.warn('[Store] Could not load training data from Postgres:', err.message);
    }
  } else {
    console.log('[Store] No DATABASE_URL — loading training from local backup only');
  }

  // Replay local backup. Identity = timestamp + first 80 chars of chosen.
  const recordKey = (p) => `${p.timestamp || ''}__${(p.chosen || '').slice(0, 80)}`;
  const seen = new Set(trainingPreferences.map(recordKey));
  const localRecords = readTrainingBackup();
  let replayed = 0;
  for (const local of localRecords) {
    const key = recordKey(local);
    if (seen.has(key)) continue;
    seen.add(key);
    local.id = local.id || uuidv4();
    local.airtableId = local.id;
    trainingPreferences.push(local);
    _incrementScenarioCount(local.workspaceId, local.scenario);
    replayed++;
  }
  if (replayed > 0) {
    console.log(`[Store] Replayed ${replayed} local-only training records from backup file.`);
  }

  if (db.isConfigured()) {
    const pendingCount = trainingPreferences.filter(p => p._airtableError || !p.id).length;
    if (pendingCount > 0) {
      console.log(`[Store] Auto-resyncing ${pendingCount} pending training records to Postgres…`);
      forceResyncTrainingToAirtable()
        .then(r => console.log(`[Store] Auto-resync done: pushed ${r.pushed}, failed ${r.failed} of ${r.totalPending}`))
        .catch(err => console.warn('[Store] Auto-resync failed:', err.message));
    }
  }
}

// Re-push any in-memory training records flagged with sync errors. Kept the
// legacy export name (`forceResyncTrainingToAirtable`) so settings.js and the
// dashboard's pending-sync banner keep working without changes.
async function forceResyncTrainingToAirtable() {
  if (!db.isConfigured()) {
    return { pushed: 0, failed: 0, error: 'DATABASE_URL not configured' };
  }
  const pending = trainingPreferences.filter(p => p._airtableError);
  let pushed = 0;
  let failed = 0;
  const errors = [];
  for (const pref of pending) {
    try {
      if (pref.thread) pref.thread = sanitizeThread(pref.thread);
      pref.id = pref.id || uuidv4();
      await db.query(`
        INSERT INTO training (
          id, type, scenario, chosen, original, selected_text, feedback,
          rating, thread, question, option_index, is_custom, avatar,
          is_canonical, source, workspace_id, timestamp
        ) VALUES (
          $1, $2, $3::jsonb, $4, $5, $6, $7,
          $8, $9::jsonb, $10, $11, $12, $13,
          $14, $15, $16, $17
        )
        ON CONFLICT (id) DO UPDATE SET
          type = EXCLUDED.type,
          scenario = EXCLUDED.scenario,
          chosen = EXCLUDED.chosen,
          original = EXCLUDED.original,
          selected_text = EXCLUDED.selected_text,
          feedback = EXCLUDED.feedback,
          rating = EXCLUDED.rating,
          thread = EXCLUDED.thread,
          question = EXCLUDED.question,
          option_index = EXCLUDED.option_index,
          is_custom = EXCLUDED.is_custom,
          avatar = EXCLUDED.avatar,
          is_canonical = EXCLUDED.is_canonical,
          source = EXCLUDED.source,
          workspace_id = EXCLUDED.workspace_id,
          timestamp = EXCLUDED.timestamp
      `, [
        pref.id, pref.type || 'draft',
        JSON.stringify(pref.scenario || {}),
        pref.chosen || '', pref.original || '', pref.selectedText || '',
        pref.feedback || '', pref.rating || '',
        JSON.stringify(pref.thread || []),
        pref.question || '', pref.optionIndex ?? -1, !!pref.isCustom,
        pref.avatar || '', !!pref.isCanonical,
        pref.source || 'training',
        pref.workspaceId || 'infeed',
        pref.timestamp || new Date().toISOString(),
      ]);
      pref.airtableId = pref.id;
      delete pref._airtableError;
      pushed++;
    } catch (err) {
      failed++;
      errors.push(err.message);
      pref._airtableError = err.message;
    }
  }
  return { pushed, failed, totalPending: pending.length, errors: errors.slice(0, 5) };
}

function getPendingTrainingSyncCount() {
  return trainingPreferences.filter(p => p._airtableError).length;
}

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
      if (r.failed > 0) {
        setTimeout(() => _scheduleAutoResync(), 60_000);
      }
    } catch (err) {
      console.warn('[Store] Auto-retry resync failed:', err.message);
      setTimeout(() => _scheduleAutoResync(), 60_000);
    }
  }, 30_000);
}

// Back-compat no-op. The Airtable client cache used to live here; Postgres
// uses an env-var-driven pool that doesn't need explicit invalidation.
function resetAirtableClient() {}

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
  appendOutboundMessage,
  updateOutboundMessageStatus,
  replaceMessages,
  deleteConversation,
  mergeConversations,
  findSyntheticConversationForLead,
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
