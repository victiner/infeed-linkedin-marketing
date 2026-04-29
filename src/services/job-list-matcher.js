// src/services/job-list-matcher.js
// Smart job-list matcher: scores active job_lists against a lead's (industry × geography × experience)
// criteria, with horizon-expanded fallbacks when an exact match isn't available.
// Pure JS — no LLM in the matching step. Optional Claude validation runs only for non-exact picks
// and is cached per (lead × asset × notes-hash) to keep cost negligible.

const horizon = require('./horizon');
const workspace = require('./workspace');

// === Scoring weights ===
const WEIGHT_INDUSTRY   = 40;
const WEIGHT_GEOGRAPHY  = 35;
const WEIGHT_EXPERIENCE = 25;
// Exact match awards full weight; horizon match awards partial.
const EXACT_RATIO    = 1.00;
const HORIZON_RATIO  = 0.60;
// Special: "global" geography is a soft match for any city (treated as horizon, not exact).
const GLOBAL_GEO_RATIO = 0.55;

const MIN_ACCEPTABLE_SCORE = 30;     // below this, no asset attached → warn
const ALTERNATE_THRESHOLD  = 30;     // alternates must score above this to surface
const EXACT_MATCH_SCORE    = 100;    // perfect on all 3 axes

function getJobListCriteria(jl) {
  // Backwards-compatible: prefer new explicit fields, fall back to legacy `segment` + `tags`.
  const industry = jl.industry || (jl.segment ? horizon.canonicalIndustry(jl.segment.replace(/-/g, '_')) : '');
  const geographies = Array.isArray(jl.geographies) && jl.geographies.length
    ? jl.geographies.map(horizon.canonicalGeography).filter(Boolean)
    : (Array.isArray(jl.tags) ? jl.tags.map(horizon.canonicalGeography).filter(g => horizon.adjacentGeography(g).length > 0 || ['global', 'europe'].includes(g)) : []);
  const experience_levels = Array.isArray(jl.experience_levels) && jl.experience_levels.length
    ? jl.experience_levels.map(horizon.canonicalExperience).filter(Boolean)
    : (Array.isArray(jl.tags) ? jl.tags.map(horizon.canonicalExperience).filter(e => horizon.adjacentExperience(e).length > 0 || e === 'senior_exec') : []);
  return { industry, geographies, experience_levels };
}

// Score a single job_list against criteria. Returns { score, breakdown }.
function scoreJobList(jl, target) {
  if (!jl || !jl.active) return { score: 0, breakdown: { reason: 'inactive_or_missing' } };
  const cri = getJobListCriteria(jl);
  const breakdown = {};
  let score = 0;

  // Industry
  if (target.industry && cri.industry) {
    if (cri.industry === horizon.canonicalIndustry(target.industry)) {
      score += WEIGHT_INDUSTRY * EXACT_RATIO;
      breakdown.industry = 'exact';
    } else if (horizon.isAdjacentIndustry(target.industry, cri.industry)) {
      score += WEIGHT_INDUSTRY * HORIZON_RATIO;
      breakdown.industry = 'horizon';
    } else {
      breakdown.industry = 'mismatch';
    }
  } else {
    breakdown.industry = 'no_signal';
  }

  // Geography — match if ANY of the list's geographies matches target
  if (target.geography && cri.geographies.length) {
    const tg = horizon.canonicalGeography(target.geography);
    if (cri.geographies.includes(tg)) {
      score += WEIGHT_GEOGRAPHY * EXACT_RATIO;
      breakdown.geography = 'exact';
    } else if (cri.geographies.some(g => horizon.isAdjacentGeography(tg, g))) {
      score += WEIGHT_GEOGRAPHY * HORIZON_RATIO;
      breakdown.geography = 'horizon';
    } else if (cri.geographies.includes('global') || cri.geographies.includes('europe')) {
      score += WEIGHT_GEOGRAPHY * GLOBAL_GEO_RATIO;
      breakdown.geography = 'global_fallback';
    } else {
      breakdown.geography = 'mismatch';
    }
  } else if (cri.geographies.includes('global')) {
    score += WEIGHT_GEOGRAPHY * GLOBAL_GEO_RATIO;
    breakdown.geography = 'global_no_target';
  } else {
    breakdown.geography = 'no_signal';
  }

  // Experience — match if ANY of the list's experience_levels matches target
  if (target.experience && cri.experience_levels.length) {
    const te = horizon.canonicalExperience(target.experience);
    if (cri.experience_levels.includes(te)) {
      score += WEIGHT_EXPERIENCE * EXACT_RATIO;
      breakdown.experience = 'exact';
    } else if (cri.experience_levels.some(e => horizon.isAdjacentExperience(te, e))) {
      score += WEIGHT_EXPERIENCE * HORIZON_RATIO;
      breakdown.experience = 'horizon';
    } else {
      breakdown.experience = 'mismatch';
    }
  } else {
    breakdown.experience = 'no_signal';
  }

  return { score: Math.round(score), breakdown };
}

// Build target criteria from a lead (profile + notes).
function buildTarget(lead, notes) {
  return {
    industry:   notes?.interest_track     || lead?.industry || lead?.segment   || '',
    geography:  notes?.target_geography   || lead?.location || '',
    experience: lead?.seniority           || '',
  };
}

// Pick the best job_list + alternates for a lead. Returns:
//   { primary: { jobList, score, breakdown } | null, alternates: [...], target, warning: { ... } | null }
function matchJobList(lead, notes, opts = {}) {
  const target = buildTarget(lead, notes);
  const allLists = workspace.getAssets()?.job_lists || [];
  const scored = allLists
    .map(jl => ({ jobList: jl, ...scoreJobList(jl, target) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { primary: null, alternates: [], target, warning: { type: 'no_lists', message: 'No job_list assets available for this lead.' } };
  }

  const primary = scored[0];
  // Alternates: distinct from primary, above threshold, max 3
  const alternates = scored.slice(1).filter(s => s.score >= ALTERNATE_THRESHOLD).slice(0, 3);

  let warning = null;
  if (primary.score < MIN_ACCEPTABLE_SCORE) {
    warning = {
      type: 'no_acceptable_match',
      message: `Best match scored only ${primary.score}/100. Consider creating a more specific job_list for industry=${target.industry || '?'}, geography=${target.geography || '?'}, experience=${target.experience || '?'}.`,
      target,
    };
  } else if (primary.score < EXACT_MATCH_SCORE) {
    warning = {
      type: 'horizon_match',
      message: `Closest match (${primary.jobList.name}) scored ${primary.score}/100 — using horizon expansion.`,
      target,
      breakdown: primary.breakdown,
    };
  }

  return { primary, alternates, target, warning };
}

// === Claude validation cache ===
// Key: leadId + assetId + notesHash. Validates only horizon-expanded picks (cost optimization).
const validationCache = new Map(); // key -> { fit, reason, ts }
const VALIDATION_TTL_MS = 30 * 60 * 1000;

function notesHash(notes) {
  if (!notes || typeof notes !== 'object') return 'empty';
  const keys = Object.keys(notes).sort();
  return keys.map(k => `${k}=${JSON.stringify(notes[k])}`).join('|');
}

let _claude = null;
function getClaude() {
  if (_claude) return _claude;
  const Anthropic = require('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required');
  _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

const HAIKU = 'claude-haiku-4-5-20251001';

// Validate that a candidate job_list actually makes sense for THIS lead given notes + thread.
// Skipped (returns 'good') for exact matches — no point burning tokens on unambiguous picks.
async function validateMatch(lead, notes, thread, candidate) {
  if (!candidate || !candidate.jobList) return { fit: 'bad', reason: 'no_candidate' };
  if (candidate.score >= EXACT_MATCH_SCORE) return { fit: 'good', reason: 'exact_match', cached: false };

  const cacheKey = `${lead?.id}__${candidate.jobList.id}__${notesHash(notes)}`;
  const cached = validationCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < VALIDATION_TTL_MS) {
    return { ...cached, cached: true };
  }

  const recentThread = (thread || []).slice(-6).map(m => `[${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`).join('\n');
  const prompt = `Decide if this job_list is a sensible thing to send to this lead RIGHT NOW.

LEAD: ${lead?.name || '?'} — ${lead?.role || '?'} at ${lead?.company || '?'} (${lead?.location || '?'})
SENIORITY: ${lead?.seniority || '?'}

EXTRACTED NOTES (${Object.keys(notes || {}).length} fields):
${JSON.stringify(notes || {}, null, 2)}

RECENT THREAD:
${recentThread || '(empty)'}

CANDIDATE JOB LIST:
- name: ${candidate.jobList.name}
- industry: ${candidate.jobList.industry || candidate.jobList.segment || 'unknown'}
- geographies: ${(candidate.jobList.geographies || ['global']).join(', ')}
- experience_levels: ${(candidate.jobList.experience_levels || ['unspecified']).join(', ')}
- description: ${candidate.jobList.description || '(none)'}

Score given by the deterministic matcher: ${candidate.score}/100 (${JSON.stringify(candidate.breakdown)})

Output ONLY JSON, no preamble:
{
  "fit": "good" | "questionable" | "bad",
  "reason": "<one short sentence on why>"
}

Rules:
- "good" = the lead would likely value receiving this list
- "questionable" = it's adjacent but might not be what they want (mention why)
- "bad" = clear mismatch (e.g. lead said "London only" but list is Frankfurt)
- Be strict on geography conflicts (lead said one place, list is elsewhere) and industry conflicts.`;

  let result;
  try {
    const res = await getClaude().messages.create({
      model: HAIKU, max_tokens: 200, temperature: 0.0,
      system: 'You validate whether a job_list candidate is sensible for a specific lead. Output strict JSON.',
      messages: [{ role: 'user', content: prompt }],
    });
    const txt = res.content[0].text.trim().replace(/```json\n?|\n?```/g, '').trim();
    result = JSON.parse(txt);
  } catch (err) {
    console.warn('[Matcher] Validation failed:', err.message);
    return { fit: 'questionable', reason: `validator_error: ${err.message}`, cached: false };
  }

  const out = { fit: result.fit || 'questionable', reason: result.reason || '', ts: Date.now() };
  validationCache.set(cacheKey, out);
  return { ...out, cached: false };
}

module.exports = {
  matchJobList,
  validateMatch,
  scoreJobList,
  buildTarget,
  getJobListCriteria,
  EXACT_MATCH_SCORE,
};
