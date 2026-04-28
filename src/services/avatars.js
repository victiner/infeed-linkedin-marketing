// src/services/avatars.js
// Avatar matrix: seniority × stage × situation. Each cell ("avatar") collects training
// examples specific to that context. At draft time the system classifies the inbound
// into an avatar, then retrieves canonical good/bad examples from that exact cell —
// far sharper than relevance-scoring a global pool.
//
// Avatar id format: "<seniority>__<stage>__<situation>" (double-underscore separator).

const Anthropic = require('@anthropic-ai/sdk');
const workspace = require('./workspace');
const store     = require('./store');

const HAIKU = 'claude-haiku-4-5-20251001';
const CLASSIFY_TTL_MS = 30 * 60 * 1000; // re-classify a conversation at most once per 30 min

let _claude = null;
function getClaude() {
  if (_claude) return _claude;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required for avatar classification');
  _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

// In-memory classification cache: conversationId -> { avatarId, ts }
const classifyCache = new Map();

// ---- AXES + IDs ----

function axes() { return workspace.getAvatarAxes(); }

function makeAvatarId(seniority, stage, situation) {
  return `${seniority || 'unknown'}__${stage || 'unknown'}__${situation || 'neutral'}`;
}

function parseAvatarId(id) {
  if (!id || typeof id !== 'string') return null;
  const [seniority, stage, situation] = id.split('__');
  return { seniority, stage, situation };
}

function listAllAvatars() {
  const a = axes();
  const out = [];
  for (const sen of a.seniority) {
    for (const stg of a.stage) {
      for (const sit of a.situation) {
        out.push({ id: makeAvatarId(sen, stg, sit), seniority: sen, stage: stg, situation: sit });
      }
    }
  }
  return out;
}

// ---- CLASSIFIER ----

const CLASSIFY_PROMPT = (thread, leadProfile, routingDecision) => {
  const a = axes();
  const lastMsg = [...(thread || [])].reverse().find(m => m.sender === 'them')?.text || '(none)';
  const recent = (thread || []).slice(-4).map(m => `[${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`).join('\n');
  return `Classify this LinkedIn conversation into one avatar across three axes.

LEAD: ${leadProfile?.name || '?'} — ${leadProfile?.role || '?'} at ${leadProfile?.company || '?'}
LEAD SENIORITY (already detected): ${leadProfile?.seniority || 'unknown'}
RECENT THREAD (last 4 turns):
${recent || '(empty — first contact)'}
THEIR LAST MESSAGE: "${lastMsg}"
${routingDecision ? `ROUTER STAGE GUESS: ${routingDecision.funnel_stage || routingDecision.stage}` : ''}
${routingDecision ? `ROUTER SENTIMENT: ${routingDecision.sentiment}` : ''}

AXES:
- seniority: ${a.seniority.join(' | ')}
- stage:     ${a.stage.join(' | ')}
- situation: ${a.situation.join(' | ')}

Situation guidance:
- neutral: no special signal, default
- curious: asking what it is, how it works, what's on the list
- price_objection: mentions cost, expensive, can't afford, value vs price
- time_objection: too busy, no time, not now
- confidentiality_objection: worried firm finds out, discretion concerns
- has_alternative: already has network / sources / similar service
- buying_signal: explicit "send me", "let's do it", "can I start"
- frustrated: annoyed, hostile, accusatory
- follow_up_after_ghosting: lead went silent for ≥2 days then replied, OR we are nudging silence
- wants_intro_to_specific_firm: lead names a specific firm and wants help with it

Return ONLY JSON, no preamble:
{"seniority": "<one of seniority>", "stage": "<one of stage>", "situation": "<one of situation>", "confidence": 0.0}`;
};

async function classifyAvatar(thread, leadProfile, routingDecision, options = {}) {
  const { conversationId } = options;
  const cached = conversationId ? classifyCache.get(conversationId) : null;
  if (cached && (Date.now() - cached.ts < CLASSIFY_TTL_MS)) {
    return { avatarId: cached.avatarId, cached: true };
  }
  const claude = getClaude();
  const res = await claude.messages.create({
    model: HAIKU,
    max_tokens: 256,
    temperature: 0.0,
    system: 'You classify LinkedIn conversations onto a three-axis avatar matrix. Output strict JSON only.',
    messages: [{ role: 'user', content: CLASSIFY_PROMPT(thread, leadProfile, routingDecision) }],
  });
  const txt = res.content[0].text.trim().replace(/```json\n?|\n?```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch { throw new Error(`Avatar classifier returned non-JSON: ${txt.slice(0, 200)}`); }

  const a = axes();
  const seniority = a.seniority.includes(parsed.seniority) ? parsed.seniority : (leadProfile?.seniority || 'unknown');
  const stage     = a.stage.includes(parsed.stage)         ? parsed.stage     : (routingDecision?.funnel_stage || 'cold_opener');
  const situation = a.situation.includes(parsed.situation) ? parsed.situation : 'neutral';

  const avatarId = makeAvatarId(seniority, stage, situation);
  if (conversationId) classifyCache.set(conversationId, { avatarId, ts: Date.now() });
  return { avatarId, confidence: parsed.confidence ?? 0.5, cached: false };
}

// ---- RETRIEVAL ----

// Pull canonical examples for an avatar, with a graceful fallback ladder.
// Returns { good: [...], bad: [...], source: 'exact'|'two_axis'|'one_axis'|'empty' }
function getCanonicalExamples(workspaceId, avatarId, opts = {}) {
  const limit = opts.limit || 3;
  const parsed = parseAvatarId(avatarId);
  if (!parsed) return { good: [], bad: [], source: 'empty' };

  const all = store.getTrainingPreferences(workspaceId);

  const matchesExact = (p) => p.avatar === avatarId;
  const matchesTwo = (p) => {
    const ax = parseAvatarId(p.avatar || '');
    if (!ax) return false;
    return (ax.seniority === parsed.seniority && ax.stage === parsed.stage)
        || (ax.stage === parsed.stage && ax.situation === parsed.situation);
  };
  const matchesOne = (p) => {
    const ax = parseAvatarId(p.avatar || '');
    if (!ax) return false;
    return ax.stage === parsed.stage || ax.seniority === parsed.seniority;
  };

  const isGood = (p) =>
    p.type === 'thumbs_up' ||
    (p.type === 'correction' && p.chosen) ||
    (p.type === 'draft' && p.chosen);
  const isBad = (p) =>
    p.type === 'thumbs_down' ||
    (p.type === 'correction' && p.original);

  const score = (p) => {
    let s = 0;
    if (p.isCanonical)         s += 100;
    if (p.type === 'correction') s += 10;
    if (p.type === 'annotation') s += 5;
    if (p.source === 'live')     s += 3;
    if (p.timestamp) s += Math.min(2, (new Date(p.timestamp).getTime() / 1e12)); // mild recency bias
    return s;
  };

  const pickFrom = (filter, kind) => {
    const filterFn = kind === 'good' ? isGood : isBad;
    return all.filter(p => filter(p) && filterFn(p))
              .sort((a, b) => score(b) - score(a))
              .slice(0, limit);
  };

  let good = pickFrom(matchesExact, 'good');
  let bad  = pickFrom(matchesExact, 'bad');
  let source = 'exact';
  if (good.length + bad.length === 0) {
    good = pickFrom(matchesTwo, 'good');
    bad  = pickFrom(matchesTwo, 'bad');
    source = 'two_axis';
  }
  if (good.length + bad.length === 0) {
    good = pickFrom(matchesOne, 'good');
    bad  = pickFrom(matchesOne, 'bad');
    source = 'one_axis';
  }
  if (good.length + bad.length === 0) source = 'empty';

  // Strip to the fields we need in the prompt
  const slim = (p) => ({
    text:        p.chosen,
    original:    p.original || '',
    feedback:    p.feedback || '',
    selectedText: p.selectedText || '',
    type:        p.type,
    isCanonical: !!p.isCanonical,
  });

  return { good: good.map(slim), bad: bad.map(slim), source };
}

// ---- COVERAGE ----

function getCoverage(workspaceId) {
  const all = store.getTrainingPreferences(workspaceId);
  // Coverage is about TRAINING SIGNAL — only count message records (skip SENTIMENT/ROUTING/empty).
  const messageRecords = all.filter(isMessageRecord);
  const buckets = new Map();
  for (const av of listAllAvatars()) {
    buckets.set(av.id, { ...av, count: 0, good: 0, bad: 0, canonical_good: 0, canonical_bad: 0 });
  }
  for (const p of messageRecords) {
    if (!p.avatar) continue;
    const b = buckets.get(p.avatar);
    if (!b) continue;
    b.count++;
    const isGood = p.type === 'thumbs_up' || (p.type === 'correction' && p.chosen) || p.type === 'draft';
    const isBad  = p.type === 'thumbs_down' || (p.type === 'correction' && p.original);
    if (isGood) b.good++;
    if (isBad)  b.bad++;
    if (p.isCanonical && isGood) b.canonical_good++;
    if (p.isCanonical && isBad)  b.canonical_bad++;
  }
  const cells = [...buckets.values()];
  return {
    cells,
    totals: {
      total_examples: messageRecords.length,
      tagged:         messageRecords.filter(p => p.avatar).length,
      untagged:       messageRecords.filter(p => !p.avatar).length,
      cells_filled:   cells.filter(c => c.count > 0).length,
      cells_total:    cells.length,
    },
  };
}

// Types that represent actual message examples (used in drafting).
// SENTIMENT and ROUTING records are classifier outputs, not training examples — we ignore them.
const MESSAGE_TYPES = new Set(['correction', 'annotation', 'thumbs_up', 'thumbs_down', 'draft']);

function isMessageRecord(p) {
  return MESSAGE_TYPES.has(p.type) && (p.chosen || p.original);
}

// Tag a "valence" (good vs bad) on each example so the UI can section/color them.
function classifyValence(p) {
  if (p.type === 'thumbs_up')   return 'good';
  if (p.type === 'thumbs_down') return 'bad';
  if (p.type === 'draft')       return 'good';
  if (p.type === 'correction') {
    return p.chosen ? 'good' : 'bad';
  }
  if (p.type === 'annotation') {
    return p.rating === 'good' ? 'good' : 'bad';
  }
  return 'neutral';
}

// Get all USEFUL examples for an avatar (filters out SENTIMENT/ROUTING/empty).
// Used by the dashboard's per-cell browser.
function getAvatarExamples(workspaceId, avatarId) {
  return store.getTrainingPreferences(workspaceId)
    .filter(p => p.avatar === avatarId && isMessageRecord(p))
    .map(p => ({
      airtableId:   p.airtableId,
      type:         p.type,
      chosen:       p.chosen,
      original:     p.original,
      selectedText: p.selectedText,
      feedback:     p.feedback,
      rating:       p.rating,
      isCanonical:  !!p.isCanonical,
      valence:      classifyValence(p),
      timestamp:    p.timestamp,
      source:       p.source,
    }))
    .sort((a, b) => {
      if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
      return (b.timestamp || '').localeCompare(a.timestamp || '');
    });
}

// Returns the EXACT examples that getCanonicalExamples would inject into the draft prompt.
// Used by the dashboard so the user can see "this is what's being sent to Claude."
function getInjectedExamples(workspaceId, avatarId, opts = {}) {
  const ex = getCanonicalExamples(workspaceId, avatarId, opts);
  return {
    source: ex.source,
    good:   ex.good.map(e => ({ ...e, valence: 'good' })),
    bad:    ex.bad.map(e  => ({ ...e, valence: 'bad'  })),
  };
}

async function setExampleCanonical(airtableId, isCanonical) {
  return store.updateTrainingFields(airtableId, { isCanonical: !!isCanonical });
}

async function setExampleAvatar(airtableId, avatarId) {
  const parsed = parseAvatarId(avatarId);
  if (!parsed) throw new Error(`Invalid avatar id: ${avatarId}`);
  return store.updateTrainingFields(airtableId, { avatar: avatarId });
}

module.exports = {
  axes,
  makeAvatarId,
  parseAvatarId,
  listAllAvatars,
  classifyAvatar,
  getCanonicalExamples,
  getInjectedExamples,
  getCoverage,
  getAvatarExamples,
  setExampleCanonical,
  setExampleAvatar,
  isMessageRecord,
  MESSAGE_TYPES,
};
