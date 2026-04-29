// src/services/lead-notes.js
// Per-lead structured notes extracted from conversation context.
// Uses Haiku (cheapest model) with strict throttling to keep cost negligible.
//
// Throttling rules (all of these must pass for an extraction to run):
//   - Last extraction was ≥ COOLDOWN_MS ago, OR there's no prior extraction
//   - The triggering message is "substantive" (≥ MIN_WORDS words)
//   - Only inbound messages from the lead trigger extraction (our own drafts don't add info)
//
// Notes schema (each field optional, all string unless noted):
//   interest_track:    'IB' | 'PE' | 'AM' | 'consulting' | 'VC' | 'corporate development' | other
//   target_geography:  free-text city/region (e.g. "London", "Frankfurt")
//   target_firm:       specific firm the lead named
//   time_horizon:      'near-term' | 'exploring' | 'passive' | 'no-timeline'
//   objection_type:    'price' | 'time' | 'confidentiality' | 'has_alternative' | 'fit' | null
//   concerns:          array of short strings
//   current_situation: 1-line summary (free text)
//   next_step_promised: anything WE committed to in past messages

const Anthropic = require('@anthropic-ai/sdk');
const store = require('./store');

const HAIKU = 'claude-haiku-4-5-20251001';
const COOLDOWN_MS = parseInt(process.env.LEAD_NOTES_COOLDOWN_MS || String(2 * 60 * 60 * 1000), 10); // 2 hours
const MIN_WORDS = parseInt(process.env.LEAD_NOTES_MIN_WORDS || '4', 10);

let _claude = null;
function getClaude() {
  if (_claude) return _claude;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required for lead notes');
  _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function shouldExtract({ lead, latestInboundText }) {
  if (!latestInboundText || wordCount(latestInboundText) < MIN_WORDS) return { run: false, reason: 'message_too_short' };
  if (!lead?.notesUpdatedAt) return { run: true };
  const elapsed = Date.now() - new Date(lead.notesUpdatedAt).getTime();
  if (elapsed < COOLDOWN_MS) return { run: false, reason: `cooldown ${Math.round((COOLDOWN_MS - elapsed) / 60000)}m left` };
  return { run: true };
}

const PROMPT = (thread, lead, current) => {
  const recent = (thread || []).slice(-8).map(m => `[${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`).join('\n');
  return `Extract structured notes about a LinkedIn lead from the conversation.

LEAD: ${lead?.name || '?'} — ${lead?.role || '?'} at ${lead?.company || '?'}, ${lead?.location || '?'}, seniority=${lead?.seniority || '?'}

RECENT THREAD (last 8 turns):
${recent || '(empty)'}

CURRENT NOTES (merge with these — only update what new info is present):
${JSON.stringify(current || {}, null, 2)}

Output ONLY a JSON object with these fields. Include a field only if you have a clear signal — do NOT guess. Omit unknown fields entirely.

{
  "interest_track":    "<IB|PE|AM|consulting|VC|corporate development|other>",
  "target_geography":  "<city or region they mentioned>",
  "target_firm":       "<specific firm they named>",
  "time_horizon":      "<near-term|exploring|passive|no-timeline>",
  "objection_type":    "<price|time|confidentiality|has_alternative|fit>",
  "concerns":          ["<short concern 1>", "..."],
  "current_situation": "<1-sentence summary of where they are>",
  "next_step_promised": "<anything WE committed to do, if mentioned>"
}

Rules:
- If a field has no clear signal in the thread, OMIT it entirely (don't include it as null/empty).
- Don't invent details. If they didn't mention a target firm, don't add one.
- Be concise. Each string field ≤ 80 characters.`;
};

async function extractFromThread(leadId, thread) {
  const lead = store.getLead(leadId);
  if (!lead) return { skipped: true, reason: 'lead_not_found' };

  const latestInbound = [...(thread || [])].reverse().find(m => m.sender === 'them');
  const decision = shouldExtract({ lead, latestInboundText: latestInbound?.text });
  if (!decision.run) return { skipped: true, reason: decision.reason };

  const claude = getClaude();
  let res;
  try {
    res = await claude.messages.create({
      model: HAIKU,
      max_tokens: 512,
      temperature: 0.0,
      system: 'You extract structured notes from LinkedIn conversations. Output strict JSON only — no markdown fences, no preamble. Omit unknown fields.',
      messages: [{ role: 'user', content: PROMPT(thread, lead, lead.notes || {}) }],
    });
  } catch (err) {
    console.warn('[LeadNotes] Haiku call failed:', err.message);
    return { skipped: true, reason: 'haiku_error', error: err.message };
  }

  const txt = res.content[0].text.trim().replace(/```json\n?|\n?```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (err) {
    console.warn('[LeadNotes] Non-JSON response:', txt.slice(0, 150));
    return { skipped: true, reason: 'non_json' };
  }

  // Merge with existing notes — only set fields that are non-empty in the new extraction.
  const merged = { ...(lead.notes || {}) };
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    merged[k] = v;
  }

  store.updateLeadNotes(leadId, merged);
  console.log(`[LeadNotes] Updated for ${lead.name}: ${Object.keys(parsed).length} fields, total ${Object.keys(merged).length}`);
  return { updated: true, fields: Object.keys(parsed), notes: merged };
}

function getNotes(leadId) {
  const lead = store.getLead(leadId);
  return lead?.notes || {};
}

async function setNotes(leadId, notes) {
  return store.updateLeadNotes(leadId, notes || {});
}

module.exports = { extractFromThread, getNotes, setNotes, shouldExtract };
