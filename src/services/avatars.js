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
const placeholders = require('./placeholders');

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
// If opts.lead/notes are provided, runs placeholder substitution so {lead.*} and {notes.*}
// tokens are filled with the active lead's actual values BEFORE Claude sees the examples.
// Examples whose required placeholders can't be filled are skipped (never sent broken text).
// Returns { good: [...], bad: [...], source: 'exact'|'two_axis'|'one_axis'|'empty', skipped: [...] }
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

  let goodSlim = good.map(slim);
  let badSlim  = bad.map(slim);
  const skipped = [];

  // Placeholder substitution. {lead.*}/{notes.*}/{asset.*} fill from passed context.
  // Examples with unfillable required placeholders are dropped (never sent as broken text).
  if (opts.lead || opts.notes || opts.asset || opts.alternates) {
    const ctx = {
      lead:       opts.lead       || {},
      notes:      opts.notes      || {},
      asset:      opts.asset      || null,
      alternates: opts.alternates || [],
    };
    const goodRendered = placeholders.renderExamples(goodSlim, ctx);
    const badRendered  = placeholders.renderExamples(badSlim,  ctx);
    goodSlim = goodRendered.kept;
    badSlim  = badRendered.kept;
    skipped.push(...goodRendered.skipped, ...badRendered.skipped);
  }

  return { good: goodSlim, bad: badSlim, source, skipped };
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
// 'qa' is a question/answer pair where lead asked something and we have a canonical reply.
const MESSAGE_TYPES = new Set(['correction', 'annotation', 'thumbs_up', 'thumbs_down', 'draft', 'qa']);

function isMessageRecord(p) {
  if (!MESSAGE_TYPES.has(p.type)) return false;
  if (p.type === 'qa') return !!(p.question && p.chosen);
  return !!(p.chosen || p.original);
}

// Tag a "valence" (good vs bad vs qa) on each example so the UI can section/color them.
function classifyValence(p) {
  if (p.type === 'qa')          return 'qa';
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
      question:     p.question,
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

// === Q&A retrieval ===
// When the lead's last message is a question, find the most similar Q&A in this avatar
// (or fallback avatars) by simple keyword overlap. No LLM call — pure JS.
// Used by the router to inject "Q&A REFERENCE" examples into the draft prompt.

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','am','do','does','did',
  'have','has','had','having','of','to','in','on','at','for','with','from','by','as',
  'this','that','these','those','i','you','he','she','it','we','they','me','him','her',
  'them','my','your','his','its','our','their','what','which','who','whom','whose','why',
  'how','when','where','can','could','would','should','will','shall','may','might','must',
  'and','or','but','if','then','than','so','too','very','just','also','any','all','some',
  'no','not','only','own','same','such','more','most','other','about','against','into',
  'through','during','before','after','above','below','between','out','off','up','down',
  'because','while','until',
]);

function tokenize(s) {
  if (!s) return new Set();
  return new Set(
    String(s).toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t))
  );
}

function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  // Jaccard on token sets
  const union = ta.size + tb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// Returns top-N Q&As for a lead's question, ranked by question-text similarity.
// Falls back across the avatar hierarchy if the exact cell has no good match.
//   limit: max Q&As to return (default 2)
//   minScore: skip Q&As below this similarity (default 0.10 — about 1 shared keyword in a short Q)
function findRelevantQAs(workspaceId, avatarId, leadQuestion, opts = {}) {
  const limit = opts.limit ?? 2;
  const minScore = opts.minScore ?? 0.10;
  const parsed = parseAvatarId(avatarId);
  if (!parsed || !leadQuestion) return [];

  const all = store.getTrainingPreferences(workspaceId).filter(p => p.type === 'qa' && p.question && p.chosen);
  if (all.length === 0) return [];

  const matchesExact = (p) => p.avatar === avatarId;
  const matchesTwoAxis = (p) => {
    const ax = parseAvatarId(p.avatar || ''); if (!ax) return false;
    return (ax.seniority === parsed.seniority && ax.stage === parsed.stage)
        || (ax.stage === parsed.stage && ax.situation === parsed.situation)
        || (ax.seniority === parsed.seniority && ax.situation === parsed.situation);
  };
  const matchesOneAxis = (p) => {
    const ax = parseAvatarId(p.avatar || ''); if (!ax) return false;
    return ax.stage === parsed.stage || ax.situation === parsed.situation;
  };

  const score = (p) => {
    let s = similarity(p.question, leadQuestion);
    if (p.isCanonical) s *= 1.5;
    return s;
  };

  // Try exact avatar first; if nothing scores above minScore, broaden.
  const tryPool = (filter, axisLabel) => {
    return all.filter(filter)
      .map(p => ({ pref: p, score: score(p), axisLabel }))
      .filter(x => x.score >= minScore)
      .sort((a, b) => b.score - a.score);
  };

  let candidates = tryPool(matchesExact, 'exact');
  if (candidates.length === 0) candidates = tryPool(matchesTwoAxis, 'two_axis');
  if (candidates.length === 0) candidates = tryPool(matchesOneAxis, 'one_axis');

  return candidates.slice(0, limit).map(c => ({
    question:    c.pref.question,
    answer:      c.pref.chosen,
    score:       Math.round(c.score * 100) / 100,
    isCanonical: !!c.pref.isCanonical,
    source:      c.axisLabel,
  }));
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
  findRelevantQAs,
  setExampleCanonical,
  setExampleAvatar,
  isMessageRecord,
  MESSAGE_TYPES,
};
