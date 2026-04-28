// src/services/avatars-migrate.js
// One-time backfill: tag every existing Training record with an Avatar id.
// Batches records into a single Haiku call (12 per batch) to keep cost low.
// Idempotent — only processes records that don't already have an Avatar.

const Anthropic = require('@anthropic-ai/sdk');
const store     = require('./store');
const workspace = require('./workspace');
const { axes, makeAvatarId } = require('./avatars');

const HAIKU = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 12;

let _claude = null;
function getClaude() {
  if (_claude) return _claude;
  _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

// Per-workspace state to surface progress to the dashboard
const state = new Map(); // wsId -> { running, total, processed, tagged, failed, startedAt, finishedAt }

function getStatus(workspaceId) {
  return state.get(workspaceId) || { running: false, total: 0, processed: 0, tagged: 0, failed: 0 };
}

function buildBatchPrompt(records) {
  const a = axes();
  const items = records.map((r, i) => {
    const sc = (r.scenario && typeof r.scenario === 'object') ? r.scenario : {};
    const lead = sc.lead || {};
    const last = sc.lastMessage || lead.lastMessage || '';
    return `[${i}] type=${r.type} | seniority_hint=${sc.seniority || 'unknown'} | stage_hint=${sc.funnelStage || sc.stage || 'unknown'} | sentiment=${sc.sentiment || ''}
   their_last_msg: "${(last || '').slice(0, 200)}"
   our_message: "${(r.chosen || '').slice(0, 240)}"`;
  }).join('\n');

  return `Classify each labeled training example onto a 3-axis avatar. Use the hints when present; infer from the message text otherwise.

AXES:
- seniority: ${a.seniority.join(' | ')}
- stage:     ${a.stage.join(' | ')}
- situation: ${a.situation.join(' | ')}

Situation rules of thumb:
- neutral: no strong signal
- curious: lead asking what / how
- price_objection: cost/expense concerns
- time_objection: too busy
- confidentiality_objection: discretion concerns
- has_alternative: already gets these / has network
- buying_signal: explicit "send me", "let's do it"
- frustrated: hostile/annoyed
- follow_up_after_ghosting: silence-then-reply or our follow-up nudge
- wants_intro_to_specific_firm: lead names a specific firm

EXAMPLES:
${items}

Return ONLY a JSON array of length ${records.length}, no preamble:
[{"i": 0, "seniority": "...", "stage": "...", "situation": "..."}, ...]`;
}

async function classifyBatch(records) {
  const claude = getClaude();
  const res = await claude.messages.create({
    model: HAIKU,
    max_tokens: 1024,
    temperature: 0.0,
    system: 'You classify training examples onto a 3-axis avatar matrix. Output strict JSON array only.',
    messages: [{ role: 'user', content: buildBatchPrompt(records) }],
  });
  const txt = res.content[0].text.trim().replace(/```json\n?|\n?```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch { throw new Error(`Batch classifier non-JSON: ${txt.slice(0, 200)}`); }
  if (!Array.isArray(parsed)) throw new Error('Batch classifier did not return array');

  const a = axes();
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const c = parsed.find(x => x.i === i) || parsed[i] || {};
    const sen = a.seniority.includes(c.seniority) ? c.seniority : (records[i].scenario?.seniority || 'unknown');
    const stg = a.stage.includes(c.stage)         ? c.stage     : (records[i].scenario?.funnelStage || records[i].scenario?.stage || 'cold_opener');
    const sit = a.situation.includes(c.situation) ? c.situation : 'neutral';
    out.push(makeAvatarId(sen, stg, sit));
  }
  return out;
}

async function runMigration(workspaceId, opts = {}) {
  const { reclassify = false } = opts;
  const wsId = workspaceId || workspace.getId();
  const cur = state.get(wsId);
  if (cur?.running) return { error: 'Migration already running for this workspace' };

  const all = store.getTrainingPreferences(wsId);
  const candidates = all.filter(p => p.airtableId && (reclassify || !p.avatar));
  const status = {
    running: true, total: candidates.length, processed: 0, tagged: 0, failed: 0,
    startedAt: new Date().toISOString(), finishedAt: null,
  };
  state.set(wsId, status);
  console.log(`[Migration] Starting avatar backfill for ${wsId}: ${candidates.length} records`);

  // Process in batches; non-blocking (caller awaits or fires-and-forgets)
  (async () => {
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      try {
        const ids = await classifyBatch(batch);
        for (let j = 0; j < batch.length; j++) {
          const rec = batch[j];
          const avatarId = ids[j];
          try {
            await store.updateTrainingFields(rec.airtableId, { avatar: avatarId });
            status.tagged++;
          } catch (err) {
            console.warn('[Migration] Update failed:', err.message);
            status.failed++;
          }
        }
      } catch (err) {
        console.warn(`[Migration] Batch ${i}-${i + batch.length} failed:`, err.message);
        status.failed += batch.length;
      }
      status.processed = Math.min(i + BATCH_SIZE, candidates.length);
      // Slight pacing to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    }
    status.running = false;
    status.finishedAt = new Date().toISOString();
    console.log(`[Migration] Done for ${wsId}: ${status.tagged} tagged, ${status.failed} failed of ${status.total}`);
  })().catch(err => {
    console.error('[Migration] Fatal error:', err);
    status.running = false;
    status.finishedAt = new Date().toISOString();
  });

  return { started: true, total: status.total };
}

module.exports = { runMigration, getStatus };
