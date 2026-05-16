// src/routes/admin.js
// Admin-only endpoints: one-time data migration from Airtable → Postgres.
// Run once after Postgres is provisioned; safe to re-run (uses upserts).
//
// Auth: requires header `x-admin-secret` to match env `ADMIN_SECRET` (or
// `WEBHOOK_SECRET` as a fallback so you don't have to set a second var).

const express = require('express');
const router = express.Router();
const db = require('../db');

function adminAuthed(req) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  const expected = process.env.ADMIN_SECRET || process.env.WEBHOOK_SECRET;
  return expected && secret === expected;
}

// GET /api/admin/db-status — confirm Postgres is reachable and which tables
// have how many rows. Useful pre-flight before triggering a migration.
router.get('/db-status', async (req, res) => {
  if (!adminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!db.isConfigured()) return res.status(400).json({ error: 'DATABASE_URL not set' });

  try {
    const tables = ['leads', 'conversations', 'actions', 'training', 'ratings', 'voice_dna'];
    const counts = {};
    for (const t of tables) {
      try {
        const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
        counts[t] = rows[0].n;
      } catch (err) {
        counts[t] = `error: ${err.message}`;
      }
    }
    res.json({ ok: true, counts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/migrate-from-airtable
// Reads every row from Airtable (using current AIRTABLE_API_KEY / AIRTABLE_BASE_ID)
// and upserts into Postgres. Idempotent — running twice keeps the data consistent.
// Returns per-table counts so you can verify.
router.post('/migrate-from-airtable', async (req, res) => {
  if (!adminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!db.isConfigured()) return res.status(400).json({ error: 'DATABASE_URL not set' });
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    return res.status(400).json({ error: 'AIRTABLE_API_KEY and AIRTABLE_BASE_ID required for migration source' });
  }

  let Airtable;
  try {
    Airtable = require('airtable');
  } catch (err) {
    return res.status(500).json({ error: 'airtable package not installed — run `npm install airtable`' });
  }

  const baseId = (process.env.AIRTABLE_BASE_ID || '').split('/')[0];
  const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(baseId);

  const tableNames = {
    leads:         process.env.AIRTABLE_LEADS_TABLE         || 'Leads',
    conversations: process.env.AIRTABLE_CONVERSATIONS_TABLE || 'Conversations',
    actions:       process.env.AIRTABLE_ACTIONS_TABLE       || 'Actions',
    training:      process.env.AIRTABLE_TRAINING_TABLE      || 'Training',
    ratings:       process.env.AIRTABLE_RATINGS_TABLE       || 'Ratings',
    voiceDna:      process.env.AIRTABLE_VOICE_DNA_TABLE     || 'VoiceDna',
  };

  const results = {};
  const safeJSON = (v) => { if (!v) return null; try { return JSON.parse(v); } catch { return v; } };

  // ---- LEADS ----
  results.leads = await migrateTable(base, tableNames.leads, async (r) => {
    const f = r.fields;
    if (!f.id) return false;
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
        linkedin_url = EXCLUDED.linkedin_url, name = EXCLUDED.name,
        role = EXCLUDED.role, company = EXCLUDED.company,
        sender_id = EXCLUDED.sender_id, tags = EXCLUDED.tags,
        stage = EXCLUDED.stage, funnel_stage = EXCLUDED.funnel_stage,
        sentiment = EXCLUDED.sentiment,
        last_routing_decision = EXCLUDED.last_routing_decision,
        last_asset_sent = EXCLUDED.last_asset_sent,
        credits_used = EXCLUDED.credits_used, credits_total = EXCLUDED.credits_total,
        trial_started = EXCLUDED.trial_started, trial_expired = EXCLUDED.trial_expired,
        call_booked = EXCLUDED.call_booked, converted = EXCLUDED.converted,
        campaign_id = EXCLUDED.campaign_id, current_step_index = EXCLUDED.current_step_index,
        last_step_at = EXCLUDED.last_step_at, notes = EXCLUDED.notes,
        notes_updated_at = EXCLUDED.notes_updated_at, workspace_id = EXCLUDED.workspace_id,
        updated_at = EXCLUDED.updated_at
    `, [
      f.id, f.linkedInUrl || '', f.name || '', f.role || '', f.company || '',
      f.senderId || '', JSON.stringify(safeJSON(f.tags) || []),
      f.stage || 'cold', f.funnelStage || 'cold_opener', f.sentiment || 'neutral',
      JSON.stringify(safeJSON(f.lastRoutingDecision) || null),
      f.lastAssetSent || null, f.creditsUsed || 0, f.creditsTotal || 20,
      !!f.trialStarted, !!f.trialExpired, !!f.callBooked, !!f.converted,
      f.campaignId || null, f.currentStepIndex || 0, f.lastStepAt || null,
      JSON.stringify(safeJSON(f.notes) || {}), f.notesUpdatedAt || null,
      f.WorkspaceId || 'infeed',
      f.createdAt || new Date().toISOString(),
      f.updatedAt || new Date().toISOString(),
    ]);
    return true;
  });

  // ---- CONVERSATIONS ----
  results.conversations = await migrateTable(base, tableNames.conversations, async (r) => {
    const f = r.fields;
    if (!f.id) return false;
    await db.query(`
      INSERT INTO conversations (id, lead_id, sender_id, messages, drafts, status, workspace_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        lead_id = EXCLUDED.lead_id, sender_id = EXCLUDED.sender_id,
        messages = EXCLUDED.messages, drafts = EXCLUDED.drafts,
        status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
    `, [
      f.id, f.leadId || null, f.senderId || null,
      JSON.stringify(safeJSON(f.messages) || []),
      JSON.stringify(safeJSON(f.drafts) || []),
      f.status || 'active', f.WorkspaceId || 'infeed',
      f.createdAt || new Date().toISOString(),
      f.updatedAt || new Date().toISOString(),
    ]);
    return true;
  });

  // ---- ACTIONS ----
  results.actions = await migrateTable(base, tableNames.actions, async (r) => {
    const f = r.fields;
    if (!f.id) return false;
    await db.query(`
      INSERT INTO actions (id, type, lead_id, conversation_id, data, result, workspace_id, timestamp)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      ON CONFLICT (id) DO NOTHING
    `, [
      f.id, f.type || '', f.leadId || null, f.conversationId || null,
      JSON.stringify(safeJSON(f.data) || {}),
      typeof f.result === 'string' ? f.result : JSON.stringify(safeJSON(f.result) || ''),
      f.WorkspaceId || 'infeed',
      f.timestamp || new Date().toISOString(),
    ]);
    return true;
  });

  // ---- TRAINING ----
  results.training = await migrateTable(base, tableNames.training, async (r) => {
    const f = r.fields;
    // Airtable training records use the Airtable record id as their id (no custom id field).
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
      r.id, f.Type || 'draft',
      JSON.stringify(safeJSON(f.Scenario) || {}),
      f.Chosen || '', f.Original || '', f.SelectedText || '',
      f.Feedback || '', f.Rating || '',
      JSON.stringify(safeJSON(f.Thread) || []),
      f.Question || '', f.OptionIndex ?? -1, !!f.IsCustom,
      f.Avatar || '', !!f.IsCanonical,
      f.Source || 'training', f.WorkspaceId || 'infeed',
      f.Timestamp || new Date().toISOString(),
    ]);
    return true;
  });

  // ---- RATINGS ----
  results.ratings = await migrateTable(base, tableNames.ratings, async (r) => {
    const f = r.fields;
    await db.query(`
      INSERT INTO ratings (id, conversation_id, lead_name, message_text, rating, category, feedback, was_auto_sent, workspace_id, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING
    `, [
      r.id, f.ConversationId || null, f.LeadName || '',
      f.MessageText || '', f.Rating || '', f.Category || '',
      f.Feedback || '', !!f.WasAutoSent, f.WorkspaceId || 'infeed',
      f.Timestamp || new Date().toISOString(),
    ]);
    return true;
  });

  // ---- VOICE DNA ----
  results.voiceDna = await migrateTable(base, tableNames.voiceDna, async (r) => {
    const f = r.fields;
    if (!f.WorkspaceId) return false;
    await db.query(`
      INSERT INTO voice_dna (id, workspace_id, dna, based_on_count, model, source_counts, generated_at)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7)
      ON CONFLICT (id) DO NOTHING
    `, [
      r.id, f.WorkspaceId,
      JSON.stringify(safeJSON(f.Json) || {}),
      f.BasedOnCount || 0, f.Model || '',
      JSON.stringify(safeJSON(f.SourceCounts) || {}),
      f.GeneratedAt || new Date().toISOString(),
    ]);
    return true;
  });

  res.json({ ok: true, results });
});

// Iterate every row of an Airtable table and apply a row handler. Returns
// { read, migrated, skipped, errors }. The handler should return true if the
// row was migrated, false if skipped (e.g. missing required field).
async function migrateTable(base, tableName, rowHandler) {
  const out = { read: 0, migrated: 0, skipped: 0, errors: [] };
  try {
    const records = await base(tableName).select().all();
    for (const r of records) {
      out.read++;
      try {
        const ok = await rowHandler(r);
        if (ok) out.migrated++;
        else    out.skipped++;
      } catch (err) {
        out.errors.push(err.message);
      }
    }
  } catch (err) {
    out.errors.push(`fetch failed: ${err.message}`);
  }
  return out;
}

module.exports = router;
