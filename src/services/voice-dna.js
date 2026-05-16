// src/services/voice-dna.js
// Voice DNA service — extracts learned writing rules from a workspace's training data
// (corrections / annotations / thumbs / drafts), persists snapshots to Postgres,
// exposes the current DNA + status, and auto-regenerates as new training arrives.
//
// Postgres table `voice_dna` (auto-created via src/db/schema.sql):
//   id, workspace_id, dna (jsonb), based_on_count, model, source_counts (jsonb), generated_at
// Always inserts a new row on regeneration (history retained); the latest by
// generated_at per workspace is treated as the active DNA.

const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const EXTRACT_MODEL = process.env.EXTRACT_VOICE_MODEL || 'claude-sonnet-4-6';

// Auto-regen thresholds
const MIN_NEW_FOR_BOOTSTRAP = parseInt(process.env.VOICE_DNA_BOOTSTRAP_MIN || '5',  10);
const MIN_NEW_FOR_REGEN     = parseInt(process.env.VOICE_DNA_REGEN_MIN     || '10', 10);
const COOLDOWN_MS           = parseInt(process.env.VOICE_DNA_COOLDOWN_MS   || String(5 * 60 * 1000), 10);

let _claude = null;

function getClaude() {
  if (_claude) return _claude;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required for voice DNA extraction');
  _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

// Per-workspace state
const cache           = new Map(); // workspaceId -> { dna, generatedAt, basedOnCount, model, sourceCounts, recordId } (latest)
const historyByWs     = new Map(); // workspaceId -> array of entries, desc by generatedAt (max MAX_HISTORY)
const inFlight        = new Map(); // workspaceId -> promise
const lastAttempt     = new Map(); // workspaceId -> ms timestamp
const newSinceLastRun = new Map(); // workspaceId -> integer

const MAX_HISTORY = 10;

// ---- LOADING ----

async function loadAll() {
  if (!db.isConfigured()) {
    console.log('[VoiceDna] DATABASE_URL not set — service will operate in memory-only mode');
    return;
  }
  try {
    const { rows } = await db.query(
      `SELECT * FROM voice_dna ORDER BY workspace_id, generated_at DESC LIMIT 500`
    );
    for (const r of rows) {
      const wsId = r.workspace_id;
      if (!wsId) continue;
      const entry = {
        dna:          r.dna || {},
        generatedAt:  r.generated_at ? new Date(r.generated_at).toISOString() : '',
        basedOnCount: r.based_on_count || 0,
        model:        r.model || '',
        sourceCounts: r.source_counts || {},
        recordId:     r.id,
      };
      // First seen per workspace = latest (records are sorted desc within ws)
      if (!cache.has(wsId)) cache.set(wsId, entry);
      if (!historyByWs.has(wsId)) historyByWs.set(wsId, []);
      const arr = historyByWs.get(wsId);
      if (arr.length < MAX_HISTORY) arr.push(entry);
    }
    console.log(`[VoiceDna] Loaded ${cache.size} workspaces, ${[...historyByWs.values()].reduce((a,b)=>a+b.length,0)} total snapshots`);
  } catch (err) {
    console.warn('[VoiceDna] Failed to load voice DNA from Postgres:', err.message);
  }
}

// ---- READS ----

function getCurrent(workspaceId) {
  return cache.get(workspaceId)?.dna || null;
}

function getStatus(workspaceId) {
  const entry = cache.get(workspaceId);
  const newCount = newSinceLastRun.get(workspaceId) || 0;
  if (!entry) {
    return { exists: false, newSinceLastRun: newCount, inFlight: inFlight.has(workspaceId) };
  }
  const ts = entry.generatedAt ? new Date(entry.generatedAt).getTime() : 0;
  return {
    exists:          true,
    generatedAt:     entry.generatedAt,
    basedOnCount:    entry.basedOnCount,
    model:           entry.model,
    sourceCounts:    entry.sourceCounts || {},
    ageHours:        ts ? Math.round((Date.now() - ts) / 3_600_000) : null,
    newSinceLastRun: newCount,
    inFlight:        inFlight.has(workspaceId),
  };
}

// ---- EXTRACTION ----

function bucketize(prefs) {
  return {
    corrections: prefs.filter(p => p.type === 'correction'),
    annotations: prefs.filter(p => p.type === 'annotation'),
    thumbs_up:   prefs.filter(p => p.type === 'thumbs_up'),
    thumbs_down: prefs.filter(p => p.type === 'thumbs_down'),
    drafts:      prefs.filter(p => p.type === 'draft'),
  };
}

function fmtExample(p) {
  const stage     = p.scenario?.funnelStage || p.scenario?.stage || 'unknown';
  const seniority = p.scenario?.seniority   || 'unknown';
  const lastMsg   = p.scenario?.lead?.lastMessage || p.scenario?.lastMessage || '';
  const ctx       = lastMsg ? ` | THEY SAID: "${lastMsg}"` : '';

  if (p.type === 'correction' && p.original) {
    return `[${stage}/${seniority}]${ctx}\n  BAD:  ${p.original}\n  GOOD: ${p.chosen}`;
  }
  if (p.type === 'annotation' && p.selectedText) {
    return `[${stage}/${seniority}] message: ${p.chosen}\n  phrase "${p.selectedText}" rated ${p.rating || '?'}: ${p.feedback || '(no feedback)'}`;
  }
  return `[${stage}/${seniority}]${ctx}\n  ${p.chosen}`;
}

function buildPrompt(buckets) {
  const sections = [];
  if (buckets.corrections.length) sections.push(
    `=== CORRECTIONS (BAD → GOOD) — strongest signal\n${buckets.corrections.map(fmtExample).join('\n\n')}`);
  if (buckets.annotations.length) sections.push(
    `=== ANNOTATIONS (phrase-level feedback)\n${buckets.annotations.map(fmtExample).join('\n\n')}`);
  if (buckets.thumbs_up.length) sections.push(
    `=== THUMBS UP\n${buckets.thumbs_up.map(fmtExample).join('\n\n')}`);
  if (buckets.thumbs_down.length) sections.push(
    `=== THUMBS DOWN\n${buckets.thumbs_down.map(fmtExample).join('\n\n')}`);
  if (buckets.drafts.length) sections.push(
    `=== DRAFT EXAMPLES (user-approved)\n${buckets.drafts.map(fmtExample).join('\n\n')}`);

  return `Analyze the personal LinkedIn DM voice of a founder based on the labeled examples below.

${sections.join('\n\n')}

Output ONLY a JSON object with this exact structure (no markdown fences, no preamble):

{
  "capitalization": "<one short rule>",
  "punctuation": "<rules>",
  "contractions": "<always/sometimes/never; which ones>",
  "rhythm": "<sentence-length pattern observed>",
  "vocabulary_use": ["<5-15 phrases the user actually uses>"],
  "vocabulary_avoid": ["<5-15 phrases that should never appear>"],
  "openers": ["<3-5 cold-open patterns>"],
  "closers": ["<3-5 closer patterns>"],
  "stage_specific": {
    "cold_opener": "<one rule>",
    "value_pitch": "<one rule>",
    "close":       "<one rule>",
    "follow_up":   "<one rule>"
  },
  "voice_quirks": ["<3-7 signature moves>"],
  "rule_summary": ["<5-10 most important rules, ranked>"]
}

Rules for extraction:
- Be CONCRETE — not "be casual" but "no exclamation points, single ? per message".
- Promote a rule only if it appears 2+ times.
- vocabulary_use: phrases in 2+ GOOD examples; vocabulary_avoid: from BAD versions and thumbs_down.
- If insufficient data for a field, use empty array or empty string. Do not fabricate.
- The rule_summary list takes precedence over everything else when a draft model uses this DNA.`;
}

// Pull training prefs for a workspace from the store (in-memory, already loaded from Airtable on boot)
function loadTrainingForWorkspace(workspaceId) {
  const store = require('./store');
  const all = store.getTrainingPreferences(workspaceId);
  return all.filter(p => p.chosen || p.original);
}

// ---- REGENERATION ----

async function _runExtraction(workspaceId) {
  const prefs = loadTrainingForWorkspace(workspaceId);
  if (prefs.length === 0) {
    throw new Error(`No training records found for workspace "${workspaceId}"`);
  }
  const buckets = bucketize(prefs);
  const sourceCounts = {
    corrections: buckets.corrections.length,
    annotations: buckets.annotations.length,
    thumbs_up:   buckets.thumbs_up.length,
    thumbs_down: buckets.thumbs_down.length,
    drafts:      buckets.drafts.length,
  };
  console.log(`[VoiceDna] Extracting for "${workspaceId}":`, sourceCounts);

  const claude = getClaude();
  const res = await claude.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 2048,
    temperature: 0.2,
    system: 'You extract concrete writing-voice rules from labeled examples. Output strict JSON only — no markdown fences, no preamble.',
    messages: [{ role: 'user', content: buildPrompt(buckets) }]
  });

  const text  = res.content[0].text.trim();
  const clean = text.replace(/```json\n?|\n?```/g, '').trim();
  let dna;
  try {
    dna = JSON.parse(clean);
  } catch (err) {
    throw new Error(`Failed to parse Claude output as JSON: ${text.substring(0, 200)}`);
  }

  const generatedAt = new Date().toISOString();
  const basedOnCount = prefs.length;

  const recordId = uuidv4();
  if (db.isConfigured()) {
    try {
      await db.query(`
        INSERT INTO voice_dna (id, workspace_id, dna, based_on_count, model, source_counts, generated_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7)
      `, [
        recordId, workspaceId, JSON.stringify(dna), basedOnCount,
        EXTRACT_MODEL, JSON.stringify(sourceCounts), generatedAt,
      ]);
    } catch (err) {
      console.warn('[VoiceDna] Postgres write failed:', err.message);
    }
  }

  const entry = { dna, generatedAt, basedOnCount, model: EXTRACT_MODEL, sourceCounts, recordId };
  cache.set(workspaceId, entry);
  // Push to history (newest first) and trim
  if (!historyByWs.has(workspaceId)) historyByWs.set(workspaceId, []);
  const histArr = historyByWs.get(workspaceId);
  histArr.unshift(entry);
  if (histArr.length > MAX_HISTORY) histArr.length = MAX_HISTORY;
  newSinceLastRun.set(workspaceId, 0);

  // Best-effort Slack notification
  try {
    const slack = require('./slack');
    if (typeof slack.notify === 'function') {
      const topRules = (dna.rule_summary || []).slice(0, 5).map(r => `• ${r}`).join('\n') || '(no rules extracted)';
      slack.notify({
        title: ':sparkles: Voice DNA updated',
        lead: { name: `Workspace: ${workspaceId}`, role: '', company: '' },
        reason: `Based on ${basedOnCount} training records (${sourceCounts.corrections} corrections, ${sourceCounts.thumbs_up + sourceCounts.thumbs_down} ratings)`,
        routing: 'voice_dna_updated',
        confidence: 1,
        draft: topRules,
        conversationId: '',
      });
    }
  } catch (err) {
    console.warn('[VoiceDna] Slack notify failed:', err.message);
  }

  return entry;
}

async function regenerate(workspaceId, { force = false } = {}) {
  if (!workspaceId) throw new Error('workspaceId required');
  if (inFlight.has(workspaceId)) {
    return inFlight.get(workspaceId).then(entry => ({ success: true, deduped: true, ...entry }));
  }
  const last = lastAttempt.get(workspaceId) || 0;
  if (!force && Date.now() - last < COOLDOWN_MS) {
    const waitS = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
    return { success: false, reason: 'cooldown', message: `Cooldown active — try again in ${waitS}s` };
  }
  lastAttempt.set(workspaceId, Date.now());
  const promise = _runExtraction(workspaceId).finally(() => inFlight.delete(workspaceId));
  inFlight.set(workspaceId, promise);
  try {
    const entry = await promise;
    return { success: true, ...entry };
  } catch (err) {
    return { success: false, reason: 'error', message: err.message };
  }
}

// Called from store.addTrainingPreference. Increments the per-workspace counter
// and triggers regeneration when a threshold is crossed. Debounced + cooldown'd.
async function maybeRegenerate(workspaceId) {
  if (!workspaceId) return null;
  const counter = (newSinceLastRun.get(workspaceId) || 0) + 1;
  newSinceLastRun.set(workspaceId, counter);

  const hasExisting = cache.has(workspaceId);
  const shouldBootstrap = !hasExisting && counter >= MIN_NEW_FOR_BOOTSTRAP;
  const shouldRefresh   =  hasExisting && counter >= MIN_NEW_FOR_REGEN;

  if (!shouldBootstrap && !shouldRefresh) return null;

  // Don't block the caller (training write) on the LLM call
  return regenerate(workspaceId).catch(err => {
    console.warn('[VoiceDna] auto-regen failed:', err.message);
    return null;
  });
}

function getHistory(workspaceId, limit = 5) {
  const arr = historyByWs.get(workspaceId) || [];
  return arr.slice(0, limit).map(e => ({
    dna:          e.dna,
    generatedAt:  e.generatedAt,
    basedOnCount: e.basedOnCount,
    model:        e.model,
    sourceCounts: e.sourceCounts || {},
  }));
}

module.exports = {
  loadAll,
  getCurrent,
  getStatus,
  getHistory,
  regenerate,
  maybeRegenerate,
};
