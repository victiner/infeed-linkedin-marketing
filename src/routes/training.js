// src/routes/training.js
const express = require('express');
const router = express.Router();
const store = require('../services/store');
const claude = require('../services/claude');
const workspace = require('../services/workspace');
const { scoreTrainingRelevance, classifySeniority } = require('../services/router');
const assets = require('../services/assets');
const avatars = require('../services/avatars');

// Heuristic copy of router.js's "is this a question?" check. We use it to decide
// whether to pull Q&A pairs from the matrix into the simulation guidance — same
// rule production drafts use, so simulation mirrors live behavior.
function looksLikeQuestion(text) {
  if (!text) return false;
  const t = String(text).trim();
  return t.includes('?')
    || /^(what|how|why|when|where|which|who|whose|whom|can|could|would|should|do|does|did|is|are|will|am)\b/i.test(t)
    || /\b(curious|wondering|tell me|explain|clarify)\b/i.test(t);
}

// Keep the last few thread turns when rendering as guidance — same constant as
// buildSimGuidance uses internally. Defined at module scope so the breakdown
// renderer below can use it too.
const THREAD_TAIL_LIMIT = 4;
function tailThread(thread) {
  if (!Array.isArray(thread) || thread.length === 0) return [];
  return thread.slice(-THREAD_TAIL_LIMIT);
}

// ---- QUEUE SYSTEM ----
// Each type has a queue. Scenarios are served from the front and removed.
// When a queue is empty, we generate a fresh batch via Claude.

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const queues = { draft: [], sentiment: [], routing: [], conversation: [] };
let queuesInitialized = false;

function initQueues() {
  if (queuesInitialized) return;
  queuesInitialized = true;
  // Seed draft + conversation from workspace scenarios
  const scenarios = getDraftScenarios();
  queues.draft = shuffle(scenarios);
  queues.conversation = shuffle(scenarios);
  // Seed sentiment + routing from hardcoded lists
  queues.sentiment = shuffle(SEED_SENTIMENT);
  queues.routing = shuffle(SEED_ROUTING);
  console.log(`[Training] Queues initialized: ${queues.draft.length} draft, ${queues.conversation.length} conversation, ${queues.sentiment.length} sentiment, ${queues.routing.length} routing`);
}

// Take the next item from a queue (removes it)
function dequeue(type) {
  initQueues();
  if (queues[type] && queues[type].length > 0) {
    return queues[type].shift();
  }
  return null;
}

// Add generated items to a queue
function enqueue(type, items) {
  initQueues();
  if (!queues[type]) queues[type] = [];
  queues[type].push(...items);
}

function queueSize(type) {
  initQueues();
  return (queues[type] || []).length;
}

// ---- SCENARIO SOURCES ----

function getDraftScenarios() {
  const ws = workspace.get();
  if (ws.training_scenarios && ws.training_scenarios.length > 0) {
    return ws.training_scenarios;
  }
  return [
    { stage: 'cold_opener', seniority: 'student', lead: { name: 'Test Lead', role: 'Professional', company: 'Company', background: 'Experienced' }, lastMessage: null, context: 'First outreach — no prior conversation' },
    { stage: 'value_pitch', seniority: 'analyst', lead: { name: 'Test Lead B', role: 'Analyst', company: 'Bank', background: 'Interested' }, lastMessage: 'Yeah I\'m interested', context: 'Replied positively to cold opener' },
    { stage: 'close', seniority: 'associate', lead: { name: 'Test Lead C', role: 'Associate', company: 'Fund', background: 'Ready' }, lastMessage: 'How much does it cost?', context: 'Asked about pricing' },
    { stage: 'objection', seniority: 'student', lead: { name: 'Test Lead D', role: 'Student', company: 'University', background: 'Skeptical' }, lastMessage: 'I don\'t want to pay that much', context: 'Price objection' },
    { stage: 'follow_up', seniority: 'analyst', lead: { name: 'Test Lead E', role: 'Analyst', company: 'Bank', background: 'Silent' }, lastMessage: null, context: 'No reply to value pitch sent 3 days ago' },
  ];
}

const SEED_SENTIMENT = [
  { message: 'Stop messaging me', expected: 'frustrated' },
  { message: 'Yeah that sounds interesting actually', expected: 'positive' },
  { message: 'How much does it cost?', expected: 'buying_signal' },
  { message: 'I\'m not sure this is for me', expected: 'neutral' },
  { message: 'This is spam', expected: 'frustrated' },
  { message: 'Can you tell me more?', expected: 'question' },
  { message: 'Ok', expected: 'neutral' },
  { message: 'Sounds good, send me the link', expected: 'positive' },
  { message: 'I already have a similar service', expected: 'negative' },
  { message: 'Not right now but maybe later', expected: 'neutral' },
];

const SEED_ROUTING = [
  { lead: { name: 'Test Lead', role: 'Professional', stage: 'cold' }, messages: [{ sender: 'us', text: 'Still on your radar?' }, { sender: 'them', text: 'Yeah actually, what do you have?' }], expectedRoute: 'send_job_list' },
  { lead: { name: 'Test Lead', role: 'Professional', stage: 'warm' }, messages: [{ sender: 'us', text: 'Here\'s what I found for your background: link' }, { sender: 'them', text: 'These look great, how do I sign up?' }], expectedRoute: 'send_payment_link' },
  { lead: { name: 'Test Lead', role: 'Professional', stage: 'cold' }, messages: [{ sender: 'us', text: 'Thinking about your next move?' }, { sender: 'them', text: 'Please stop contacting me' }], expectedRoute: 'human_takeover' },
  { lead: { name: 'Test Lead', role: 'Professional', stage: 'warm' }, messages: [{ sender: 'us', text: 'Pulled some options for you: link' }, { sender: 'them', text: 'Can we jump on a quick call?' }], expectedRoute: 'book_call' },
];

// ---- GENERATORS ----
// Each generator calls Claude, returns parsed scenarios, and enqueues them.

// Collect all used lead names to avoid duplicates in generation
function usedLeadNames() {
  const fromScenarios = getDraftScenarios().map(s => s.lead?.name).filter(Boolean);
  const fromPrefs = store.getTrainingPreferences(workspace.getId())
    .filter(p => p.scenario?.lead?.name)
    .map(p => p.scenario.lead.name);
  return [...new Set([...fromScenarios, ...fromPrefs])];
}

// Count training per seniority/stage combo from saved preferences
function trainingCounts() {
  const prefs = store.getTrainingPreferences(workspace.getId()).filter(p => p.type === 'draft');
  const counts = {};
  prefs.forEach(p => {
    const key = `${p.scenario?.seniority || '?'}/${p.scenario?.stage || '?'}`;
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

async function generateDraftBatch() {
  const ws = workspace.get();
  const seniorities = [...new Set(getDraftScenarios().map(s => s.seniority).filter(Boolean))];
  const stages = [...new Set(getDraftScenarios().map(s => s.stage).filter(Boolean))];
  if (seniorities.length === 0) seniorities.push('student', 'analyst', 'associate');
  if (stages.length === 0) stages.push('cold_opener', 'value_pitch', 'objection', 'close', 'follow_up');

  const counts = trainingCounts();
  const combos = [];
  for (const sen of seniorities) {
    for (const stg of stages) {
      combos.push({ seniority: sen, stage: stg, count: counts[`${sen}/${stg}`] || 0 });
    }
  }
  combos.sort((a, b) => a.count - b.count);
  const gaps = combos.slice(0, 5).map(g => `- ${g.seniority} / ${g.stage} (${g.count} trained)`).join('\n');

  const pastPrefs = store.getTrainingPreferences(workspace.getId())
    .filter(p => p.type === 'draft')
    .slice(-10)
    .map(p => `Seniority: ${p.scenario?.seniority || '?'}, Stage: ${p.scenario?.stage || '?'}, Chosen: "${p.chosen}"`)
    .join('\n');

  const excludeNames = usedLeadNames().slice(-30).join(', ');

  const prompt = `Generate 6 new LinkedIn DM training scenarios for ${ws.company?.name || 'a high-finance career platform'}.

The platform: ${ws.company?.what_it_is || 'curated high-finance roles + application support'}

PRIORITY — focus on these undercovered combos:
${gaps}

Available seniority levels: ${seniorities.join(', ')}
Available stages: ${stages.join(', ')}
DO NOT reuse these lead names: ${excludeNames}

Each scenario needs:
- stage: one of [${stages.join(', ')}]
- seniority: one of [${seniorities.join(', ')}]
- lead: { name, role, company, location, background }
- lastMessage: what the lead said (null for cold_opener and follow_up)
- context: one-line instruction for the responder
- sentiment: positive|neutral|negative|curious|buying_signal

Make leads realistic — real firm names, varied geographies.

LEAD PROFILE RULES — CRITICAL:
The user only sees what's on a LinkedIn profile when reaching out: name, current role, current company, industry, location, tenure, prior firms, education. The user does NOT know the lead's intentions, future plans, or what they're looking for. The "background" field MUST be limited to observable LinkedIn data only.
- ALLOWED in background: years/tenure in current role, prior firms, school + grad year, certifications (CFA etc.), notable past employers.
- FORBIDDEN in background: "targeting X", "considering a move", "looking for Y", "wants to transition to Z", "actively job-hunting", "open to opportunities", any forward-looking intent or career goal. The user has no way to know any of that before the conversation starts.
- Example GOOD background: "2 years at Goldman M&A, prior summer at Morgan Stanley, LSE 2024 grad."
- Example BAD background: "2 years in GS M&A, target: PE roles in EMEA, considering move within 6 months." (the "target" and "considering move" parts are intent the user could not know.)
${pastPrefs ? `\nSTYLE CONTEXT:\n${pastPrefs}` : ''}

Return ONLY valid JSON array, no markdown:
[{"stage":"...","seniority":"...","lead":{"name":"...","role":"...","company":"...","location":"...","background":"..."},"lastMessage":"...","context":"...","sentiment":"..."}, ...]`;

  const raw = await claude.raw(prompt);
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const items = match ? JSON.parse(match[0]) : [];
    const valid = items.filter(s => s.stage && s.lead?.name);
    // Also save to workspace so they persist in-memory
    const ws2 = workspace.get();
    if (!ws2.training_scenarios) ws2.training_scenarios = [...getDraftScenarios()];
    valid.forEach(s => ws2.training_scenarios.push(s));
    console.log(`[Training] Generated ${valid.length} draft scenarios`);
    return valid;
  } catch (e) {
    console.error('[Training] Draft generation parse error:', e.message);
    return [];
  }
}

async function generateSentimentBatch() {
  const wsId = workspace.getId();
  const allMessages = [...SEED_SENTIMENT, ...(queues.sentiment || [])].map(s => s.message);

  const sentimentTypes = ['positive', 'neutral', 'negative', 'frustrated', 'question', 'buying_signal'];
  const counts = {};
  sentimentTypes.forEach(t => { counts[t] = 0; });
  store.getTrainingPreferences(wsId)
    .filter(p => p.type === 'sentiment')
    .forEach(p => { counts[p.chosen] = (counts[p.chosen] || 0) + 1; });

  const gaps = sentimentTypes
    .map(t => ({ type: t, count: counts[t] }))
    .sort((a, b) => a.count - b.count)
    .map(g => `- ${g.type}: ${g.count} trained`)
    .join('\n');

  const prompt = `Generate 6 new realistic LinkedIn DM messages that a lead might send, for sentiment classification training.

Context: A high-finance career platform reaching out to finance professionals about curated job opportunities.

PRIORITY — focus on underrepresented sentiments:
${gaps}

DO NOT repeat or closely paraphrase:
${allMessages.slice(-15).map(m => `- "${m}"`).join('\n')}

Return ONLY valid JSON array, no markdown:
[{"message": "...", "expected": "positive|neutral|negative|frustrated|question|buying_signal"}, ...]`;

  const raw = await claude.raw(prompt);
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const items = match ? JSON.parse(match[0]) : [];
    const valid = items.filter(s => s.message && s.expected);
    console.log(`[Training] Generated ${valid.length} sentiment scenarios`);
    return valid;
  } catch (e) {
    console.error('[Training] Sentiment generation parse error:', e.message);
    return [];
  }
}

async function generateRoutingBatch() {
  const wsId = workspace.getId();
  const ws = workspace.get();
  const routes = ['send_job_list', 'send_landing_page', 'book_call', 'send_payment_link', 'send_onboarding_link', 'follow_up_ai', 'follow_up_manual', 'human_takeover', 'mark_not_interested', 'no_action'];

  const counts = {};
  routes.forEach(r => { counts[r] = 0; });
  store.getTrainingPreferences(wsId)
    .filter(p => p.type === 'routing')
    .forEach(p => { counts[p.chosen] = (counts[p.chosen] || 0) + 1; });

  const gaps = routes
    .map(r => ({ route: r, count: counts[r] }))
    .sort((a, b) => a.count - b.count)
    .map(g => `- ${g.route}: ${g.count} trained`)
    .join('\n');

  const prompt = `Generate 6 new LinkedIn DM routing scenarios for training. Each has a lead profile and a 2-message conversation (us → them). The user picks the next action.

Context: ${ws.company?.name || 'A'} — ${ws.company?.tagline || 'career platform'}. We reach out about curated job opportunities.

PRIORITY — generate for these underrepresented routes:
${gaps}

Available routes: ${routes.join(', ')}

Return ONLY valid JSON array, no markdown:
[{"lead":{"name":"...","role":"...","stage":"cold|warm|hot"},"messages":[{"sender":"us","text":"..."},{"sender":"them","text":"..."}],"expectedRoute":"..."}, ...]`;

  const raw = await claude.raw(prompt);
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const items = match ? JSON.parse(match[0]) : [];
    const valid = items.filter(s => s.lead && s.messages && s.expectedRoute);
    console.log(`[Training] Generated ${valid.length} routing scenarios`);
    return valid;
  } catch (e) {
    console.error('[Training] Routing generation parse error:', e.message);
    return [];
  }
}

// ---- HELPERS ----

function scenarioKey(scenario) {
  const seniority = scenario?.seniority || 'unknown';
  const stage = scenario?.stage || scenario?.funnelStage || 'unknown';
  const leadName = (scenario?.lead?.name || '').replace(/\s+/g, '_');
  return `${seniority}_${stage}_${leadName}`;
}

function getPreferenceExamples(type) {
  return store.getTrainingPreferences(workspace.getId())
    .filter(p => !type || p.type === type)
    .slice(-20)
    .map(p => `Chosen: "${p.chosen}"`)
    .join('\n');
}

function inferStage(ourMessageCount) {
  if (ourMessageCount <= 1) return 'cold_opener';
  if (ourMessageCount === 2) return 'value_pitch';
  return 'close';
}

function buildTurnScenario(lead, seniority, stage) {
  return {
    lead: lead || {},
    seniority: seniority || 'unknown',
    funnelStage: stage,
    stage,
    sentiment: '',
    assetSegment: '',
    nextObjection: '',
    context: '',
    scenarioKey: `${seniority || 'unknown'}_${stage}_${(lead?.name || '').replace(/\s+/g, '_')}`,
  };
}

// ---- ROUTES ----

// GET /training/scenario?type=draft|sentiment|routing
router.get('/scenario', async (req, res) => {
  const type = req.query.type || 'draft';
  try {
    if (type === 'sentiment') {
      let scenario = dequeue('sentiment');
      if (!scenario) {
        const batch = await generateSentimentBatch();
        enqueue('sentiment', batch);
        scenario = dequeue('sentiment');
      }
      if (!scenario) return res.status(404).json({ error: 'Could not generate sentiment scenarios' });
      const options = ['positive', 'neutral', 'negative', 'frustrated', 'question', 'buying_signal'];
      return res.json({ type: 'sentiment', scenario, options, remaining: queueSize('sentiment') });
    }

    if (type === 'routing') {
      let scenario = dequeue('routing');
      if (!scenario) {
        const batch = await generateRoutingBatch();
        enqueue('routing', batch);
        scenario = dequeue('routing');
      }
      if (!scenario) return res.status(404).json({ error: 'Could not generate routing scenarios' });
      const options = ['send_job_list', 'send_landing_page', 'book_call', 'send_payment_link', 'send_onboarding_link', 'follow_up_ai', 'follow_up_manual', 'human_takeover', 'mark_not_interested', 'no_action'];
      return res.json({ type: 'routing', scenario, options, remaining: queueSize('routing') });
    }

    // Draft
    let scenario = dequeue('draft');
    if (!scenario) {
      const batch = await generateDraftBatch();
      enqueue('draft', batch);
      scenario = dequeue('draft');
    }
    if (!scenario) return res.status(404).json({ error: 'Could not generate draft scenarios' });

    const styleExamples = getPreferenceExamples('draft');
    const prompt = `Generate 3 different LinkedIn DM response options that WE would send to this lead. We are the outreach side (the platform described in your system prompt) — the lead is the recipient. Never invert this: do not pitch the lead's own work back to them.

Each option should be distinctly different but all should sound human, casual, and short (5-15 words for simple replies, max 2-3 lines for pitches).

SCENARIO:
Lead (recipient): ${scenario.lead.name} — ${scenario.lead.role}
Background: ${scenario.lead.background}
Stage: ${scenario.stage}
Context: ${scenario.context}
${scenario.lastMessage ? `Their last message to us: "${scenario.lastMessage}"` : 'No prior message — first outreach.'}
${styleExamples ? `\nMATCH THIS STYLE:\n${styleExamples}\n` : ''}

Return ONLY a JSON array of 3 strings. No markdown.`;

    const response = await claude.raw(prompt);
    let options;
    try {
      const match = response.match(/\[[\s\S]*\]/);
      options = match ? JSON.parse(match[0]) : [response];
    } catch { options = [response]; }

    res.json({ type: 'draft', scenario, options, remaining: queueSize('draft') });
  } catch (err) {
    console.error('[Training] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /training/preference
router.post('/preference', async (req, res) => {
  const { type, scenario, chosen, original, optionIndex, isCustom, source, thread, avatar, question } = req.body;
  if (!chosen) return res.status(400).json({ error: 'chosen required' });
  // Q&A type requires question text — block silently-broken records that
  // wouldn't pass isMessageRecord later anyway.
  if ((type === 'qa') && (!question || !String(question).trim())) {
    return res.status(400).json({ error: 'question required for type=qa' });
  }

  const pref = { type: type || 'draft', scenario, chosen, optionIndex, isCustom, source: source || 'training', timestamp: new Date().toISOString() };
  if (original) pref.original = original;
  if (Array.isArray(thread) && thread.length > 0) pref.thread = thread;
  // Q&A pairs carry the lead's question alongside the canonical answer.
  // Stored on the same matrix cell as other training but retrieved by the
  // router via question-text similarity (avatars.findRelevantQAs) when the
  // lead's last inbound looks like a question.
  if (question && String(question).trim()) pref.question = String(question).trim();

  // Auto-canonical for simulation rewrites: when the user explicitly says
  // "this BAD message should be GOOD like this", that's the strongest possible
  // signal. Mark it canonical so it gets the +100 score boost in the avatar
  // cell and lands at the top of the prompt for that exact context. Other sim
  // signals (thumbs, annotations) stay non-canonical — the user can still ★
  // them manually in the matrix detail view.
  if ((type || 'draft') === 'correction' && (source === 'simulation') && original && chosen) {
    pref.isCanonical = true;
  }

  // Avatar tagging: prefer the explicit avatarId from the dashboard (set during
  // /simulation/step) so saves immediately land in the right matrix cell. If
  // missing, fall back to a server-side classifyAvatar — guarantees no record
  // ever lands untagged, regardless of which UI path produced it.
  if (avatar && typeof avatar === 'string') {
    pref.avatar = avatar;
  } else if (scenario && (scenario.seniority || scenario.funnelStage || scenario.stage)) {
    try {
      const leadProfile = {
        name: scenario.lead?.name,
        role: scenario.lead?.role,
        company: scenario.lead?.company || '',
        location: scenario.lead?.location || '',
        summary: scenario.lead?.background || '',
        seniority: scenario.seniority || 'unknown',
      };
      const routingDecision = {
        funnel_stage: scenario.funnelStage || scenario.stage || 'cold_opener',
        sentiment:    scenario.sentiment || '',
        intent:       scenario.intent || '',
        next_objection: scenario.nextObjection || '',
      };
      const cls = await avatars.classifyAvatar(thread || [], leadProfile, routingDecision);
      pref.avatar = cls.avatarId;
    } catch (err) {
      console.warn('[Training] Server-side avatar classify failed:', err.message);
    }
  }

  store.addTrainingPreference(pref);
  const total = store.getTrainingPreferences().length;
  console.log(`[Training] ${type || 'draft'} preference recorded (${total} total)${pref.avatar ? ` avatar=${pref.avatar}` : ' (no avatar)'}${original ? ' [correction]' : ''}`);
  res.json({ success: true, totalPreferences: total, avatar: pref.avatar || null });
});

// POST /training/rate
router.post('/rate', (req, res) => {
  const { conversationId, leadName, messageText, rating, category, feedback, wasAutoSent } = req.body;
  if (!rating) return res.status(400).json({ error: 'rating required' });

  store.addMessageRating({ conversationId, leadName, messageText, rating, category, feedback, wasAutoSent, timestamp: new Date().toISOString() });
  console.log(`[Training] Message rated: ${rating}/5 (${category || 'general'})`);
  res.json({ success: true });
});

// GET /training/coverage
router.get('/coverage', (req, res) => {
  initQueues();
  const scenarios = getDraftScenarios();
  const draftRemaining = queueSize('draft');
  const total = scenarios.length;
  const trained = total - draftRemaining;
  const saturated = Math.max(0, trained);

  // Build coverage array the frontend expects
  const coverage = scenarios.slice(0, 10).map((s, i) => ({
    key: scenarioKey(s),
    seniority: s.seniority || 'unknown',
    stage: s.stage || 'unknown',
    lead: s.lead?.name || '',
    context: s.context || '',
    count: i < trained ? 5 : 0,
    saturated: i < trained,
  }));

  res.json({
    threshold: 5,
    total,
    saturated,
    remaining: draftRemaining,
    percentComplete: total > 0 ? Math.round((saturated / total) * 100) : 100,
    coverage: coverage.sort((a, b) => a.count - b.count),
    queued: { draft: queueSize('draft'), conversation: queueSize('conversation'), sentiment: queueSize('sentiment'), routing: queueSize('routing') },
  });
});

// GET /training/stats
router.get('/stats', (req, res) => {
  const wsId = workspace.getId();
  const prefs = store.getTrainingPreferences(wsId);
  const ratings = store.getMessageRatings(wsId);
  const byType = { conversation: 0, simulation: 0, targeted: 0, draft: 0, sentiment: 0, routing: 0 };
  prefs.forEach(p => {
    const src = p.source || 'training';
    if (src === 'simulation') byType.simulation++;
    else if (src === 'conversation') byType.conversation++;
    else if (src === 'targeted') byType.targeted++;
    else if (p.type === 'sentiment') byType.sentiment++;
    else if (p.type === 'routing') byType.routing++;
    else byType.draft++;
  });
  const avgRating = ratings.length ? (ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(1) : null;
  initQueues();
  res.json({
    workspace: wsId,
    totalPreferences: prefs.length,
    byType,
    totalRatings: ratings.length,
    averageRating: avgRating,
    queued: { draft: queueSize('draft'), conversation: queueSize('conversation'), sentiment: queueSize('sentiment'), routing: queueSize('routing') },
  });
});

// POST /training/annotate — save word-level feedback on a response option
router.post('/annotate', async (req, res) => {
  const { scenario, optionText, selectedText, feedback, rating, source, thread, avatar } = req.body;
  if (!optionText || !selectedText || !feedback) {
    return res.status(400).json({ error: 'optionText, selectedText, and feedback required' });
  }

  const annotation = {
    type: 'annotation',
    scenario: scenario || {},
    chosen: optionText,
    selectedText,
    feedback,
    rating: rating || 'neutral',
    source: source || 'training',
    timestamp: new Date().toISOString(),
  };
  if (Array.isArray(thread) && thread.length > 0) annotation.thread = thread;

  // Same avatar tagging as /preference — explicit avatarId wins, otherwise
  // server classifies so the annotation lands in the correct matrix cell.
  if (avatar && typeof avatar === 'string') {
    annotation.avatar = avatar;
  } else if (scenario && (scenario.seniority || scenario.funnelStage || scenario.stage)) {
    try {
      const leadProfile = {
        name: scenario.lead?.name,
        role: scenario.lead?.role,
        company: scenario.lead?.company || '',
        location: scenario.lead?.location || '',
        summary: scenario.lead?.background || '',
        seniority: scenario.seniority || 'unknown',
      };
      const routingDecision = {
        funnel_stage: scenario.funnelStage || scenario.stage || 'cold_opener',
        sentiment:    scenario.sentiment || '',
        intent:       scenario.intent || '',
        next_objection: scenario.nextObjection || '',
      };
      const cls = await avatars.classifyAvatar(thread || [], leadProfile, routingDecision);
      annotation.avatar = cls.avatarId;
    } catch (err) {
      console.warn('[Training] Server-side avatar classify failed (annotate):', err.message);
    }
  }

  store.addTrainingPreference(annotation);
  console.log(`[Training] Annotation: "${selectedText}" → ${rating} (${feedback.substring(0, 50)})${annotation.avatar ? ` avatar=${annotation.avatar}` : ''}`);
  res.json({ success: true, avatar: annotation.avatar || null });
});

// GET /training/export
router.get('/export', (req, res) => {
  const wsId = workspace.getId();
  const prefs = store.getTrainingPreferences(wsId);
  const ratings = store.getMessageRatings(wsId);

  let csv = 'Section,Type,Source,Timestamp,Scenario/Lead,Chosen/Message,Rating,Category,Feedback,IsCustom,WorkspaceId\n';
  prefs.forEach(p => {
    const scenarioStr = typeof p.scenario === 'object'
      ? `${p.scenario?.lead?.name || ''} (${p.scenario?.stage || p.type})`
      : String(p.scenario || '');
    csv += `Training,${p.type},${p.source || ''},${p.timestamp},"${scenarioStr.replace(/"/g, '""')}","${String(p.chosen).replace(/"/g, '""')}",,,${p.isCustom ? 'Yes' : 'No'},${wsId}\n`;
  });
  ratings.forEach(r => {
    csv += `Rating,,,${r.timestamp},"${(r.leadName || '').replace(/"/g, '""')}","${String(r.messageText || '').replace(/"/g, '""')}",${r.rating},${r.category || ''},"${(r.feedback || '').replace(/"/g, '""')}",${wsId}\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=training-export-${wsId}-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(csv);
});

// POST /training/conversation/start
router.post('/conversation/start', async (req, res) => {
  try {
    let scenario = dequeue('conversation');
    if (!scenario) {
      const batch = await generateDraftBatch();
      enqueue('conversation', batch);
      scenario = dequeue('conversation');
    }
    if (!scenario) return res.status(404).json({ error: 'No scenarios available' });

    const lead = { ...scenario.lead };
    const seniority = scenario.seniority || 'unknown';
    const styleExamples = getPreferenceExamples('draft');

    const prompt = `Generate 3 different LinkedIn DM cold opener options that WE would send to this lead as a first message. We are the outreach side (the platform described in your system prompt) — the lead is the recipient.

Each should be distinctly different but all should sound human, casual, and short (max 2-3 lines).

LEAD (recipient): ${lead.name} — ${lead.role}
Background: ${lead.background}
${lead.location ? `Location: ${lead.location}` : ''}
${styleExamples ? `\nMATCH THIS STYLE:\n${styleExamples}\n` : ''}

Return ONLY a JSON array of 3 strings. No markdown.`;

    const response = await claude.raw(prompt);
    let options;
    try {
      const match = response.match(/\[[\s\S]*\]/);
      options = match ? JSON.parse(match[0]) : [response];
    } catch { options = [response]; }

    res.json({ lead, seniority, thread: [], options, ended: false, stage: 'cold_opener', remaining: queueSize('conversation') });
  } catch (err) {
    console.error('[Training] Conversation start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /training/conversation/reply
router.post('/conversation/reply', async (req, res) => {
  const { lead, seniority, thread, chosenReply } = req.body;
  if (!lead || !chosenReply) return res.status(400).json({ error: 'lead and chosenReply required' });

  const updatedThread = [...(thread || []), { sender: 'us', text: chosenReply }];
  const ourCount = updatedThread.filter(m => m.sender === 'us').length;
  const currentStage = inferStage(ourCount);

  store.addTrainingPreference({
    type: 'draft',
    scenario: buildTurnScenario(lead, seniority, currentStage),
    chosen: chosenReply,
    optionIndex: -1,
    isCustom: false,
    source: 'conversation',
    timestamp: new Date().toISOString(),
  });

  try {
    const threadStr = updatedThread.map(m => `[${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`).join('\n');

    const replyPrompt = `You are simulating a realistic LinkedIn lead for training purposes. Play the role of this lead.

LEAD PROFILE:
Name: ${lead.name}
Role: ${lead.role}
Background: ${lead.background}
${lead.location ? `Location: ${lead.location}` : ''}

CONVERSATION SO FAR:
${threadStr}

Rules:
- Sound like a real person on LinkedIn DM — short, casual, realistic
- React naturally. Sometimes curious, sometimes skeptical, sometimes brief
- Do NOT be overly enthusiastic
- If the conversation has reached a natural end (agreed to sign up, booked a call, or clearly rejected), set ended to true

Return ONLY valid JSON, no markdown:
{ "reply": "the lead's message", "ended": false }`;

    const replyRaw = await claude.raw(replyPrompt);
    let parsed;
    try {
      const match = replyRaw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { reply: replyRaw, ended: false };
    } catch { parsed = { reply: replyRaw, ended: false }; }

    updatedThread.push({ sender: 'them', text: parsed.reply });

    if (parsed.ended) {
      return res.json({ lead, seniority, thread: updatedThread, options: [], ended: true, stage: 'ended' });
    }

    const styleExamples = getPreferenceExamples('draft');
    const optionsPrompt = `Generate 3 different LinkedIn DM response options that WE would send next. We are the outreach side (the platform described in your system prompt) — the lead is the recipient.

Each should be distinctly different, human, casual, and short.

LEAD: ${lead.name} — ${lead.role}
Background: ${lead.background}

CONVERSATION SO FAR:
${updatedThread.map(m => `[${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`).join('\n')}
${styleExamples ? `\nMATCH THIS STYLE:\n${styleExamples}\n` : ''}

Return ONLY a JSON array of 3 strings. No markdown.`;

    const optionsRaw = await claude.raw(optionsPrompt);
    let options;
    try {
      const match = optionsRaw.match(/\[[\s\S]*\]/);
      options = match ? JSON.parse(match[0]) : [optionsRaw];
    } catch { options = [optionsRaw]; }

    res.json({ lead, seniority, thread: updatedThread, options, ended: false, stage: inferStage(ourCount + 1) });
  } catch (err) {
    console.error('[Training] Conversation reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /training/filters
router.get('/filters', (req, res) => {
  const scenarios = getDraftScenarios();
  const ws = workspace.get();
  const seniorities = [...new Set(scenarios.map(s => s.seniority).filter(Boolean))];
  const stages = [...new Set(scenarios.map(s => s.stage).filter(Boolean))];
  const avatars = (ws.avatars || []).map(a => ({ id: a.id, name: a.name, seniority: a.seniority }));
  res.json({ seniorities, stages, avatars });
});

// Generate scenarios for a specific seniority/stage combo (and optional situation).
async function generateTargetedBatch(seniority, stage, situation) {
  const ws = workspace.get();
  const excludeNames = usedLeadNames().slice(-30).join(', ');
  const pastPrefs = store.getTrainingPreferences(workspace.getId())
    .filter(p => p.type === 'draft' && p.scenario?.seniority === seniority)
    .slice(-10)
    .map(p => `Stage: ${p.scenario?.stage}, Chosen: "${p.chosen}"`)
    .join('\n');

  // Situation hint: shapes the lead profile so the resulting scenario can land
  // in the target situation cell. Only added when explicitly requested by the
  // auto-fill coverage flow — leaves the original behavior unchanged for the
  // legacy /simulation/start callers.
  const situationHint = ({
    wants_intro_to_specific_firm: 'Lead works at (or is targeting) a recognizable bulge-bracket / elite-boutique firm — the kind a candidate might ask for an intro to. Vary the firm across scenarios.',
    confidentiality_objection:    'Lead is currently employed at a known firm — discretion is plausible (they don\'t want their employer to know they\'re looking).',
    has_alternative:              'Lead has visible network signals (degree from a target school, past internships at competitors) so "I already have a network" is plausible.',
    price_objection:              'Lead is early-career (student / intern / junior analyst) where price sensitivity is realistic.',
    time_objection:               'Lead is in a high-intensity seat (M&A analyst, IB associate) where "no time" is plausible.',
    frustrated:                   'Lead has been on LinkedIn long enough to be tired of DMs — their profile suggests they get a lot of outreach.',
    buying_signal:                'Lead profile shows active job-search behavior (Open To Work, recent role change, "looking for new opportunities" in headline).',
    follow_up_after_ghosting:     'Standard analyst lead — they will go silent after our value pitch. No special profile shape needed.',
    curious:                      'Lead profile is exploratory — early career or recently transitioned, may be open to learning what we do.',
    neutral:                      'Standard professional profile. No strong objection signals expected.',
  })[situation || ''] || '';

  const prompt = `Generate 4 LinkedIn DM training scenarios for ${ws.company?.name || 'a high-finance career platform'}.

The platform: ${ws.company?.what_it_is || 'curated high-finance roles + application support'}

ALL scenarios MUST have:
- seniority: "${seniority || 'analyst'}"
- stage: "${stage || 'value_pitch'}"
${situation ? `- situation context: "${situation}"` : ''}

DO NOT reuse these names: ${excludeNames}

Each needs: stage, seniority, lead: {name, role, company, location, background}, lastMessage (null for cold_opener/follow_up), context, sentiment.
Make leads realistic — real firms, varied geographies.

LEAD PROFILE RULES — CRITICAL:
The user only sees what's on a LinkedIn profile when reaching out: name, current role, current company, industry, location, tenure, prior firms, education. The user does NOT know the lead's intentions, future plans, or what they're looking for. The "background" field MUST be limited to observable LinkedIn data only.
- ALLOWED in background: years/tenure in current role, prior firms, school + grad year, certifications, notable past employers.
- FORBIDDEN in background: "targeting X", "considering a move", "looking for Y", "wants to transition", "actively job-hunting", "open to opportunities", or any forward-looking intent. The user has no way to know any of that before the conversation starts.
- Example GOOD: "2 years at Goldman M&A, prior summer at Morgan Stanley, LSE 2024."
- Example BAD: "2 years in GS M&A, target: PE roles in EMEA, considering move within 6 months."${situationHint ? `\n\nSCENARIO SHAPING (situation: ${situation}):\n${situationHint}` : ''}
${pastPrefs ? `\nSTYLE CONTEXT:\n${pastPrefs}` : ''}

Return ONLY valid JSON array, no markdown:
[{"stage":"${stage || 'value_pitch'}","seniority":"${seniority || 'analyst'}","lead":{"name":"...","role":"...","company":"...","location":"...","background":"..."},"lastMessage":"...","context":"...","sentiment":"..."}, ...]`;

  const raw = await claude.raw(prompt);
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const items = match ? JSON.parse(match[0]) : [];
    const valid = items.filter(s => s.stage && s.lead?.name);
    console.log(`[Training] Generated ${valid.length} targeted scenarios (${seniority}/${stage})`);
    return valid;
  } catch (e) {
    console.error('[Training] Targeted generation error:', e.message);
    return [];
  }
}

// GET /training/targeted?seniority=analyst&stage=value_pitch
router.get('/targeted', async (req, res) => {
  const { seniority, stage } = req.query;
  if (!seniority && !stage) return res.status(400).json({ error: 'At least one of seniority or stage required' });

  try {
    initQueues();
    // Find matching scenario in draft queue
    let idx = queues.draft.findIndex(s =>
      (!seniority || s.seniority === seniority) && (!stage || s.stage === stage)
    );

    let scenario;
    if (idx >= 0) {
      scenario = queues.draft.splice(idx, 1)[0];
    } else {
      // Generate specifically for this seniority/stage combo
      const batch = await generateTargetedBatch(seniority, stage);
      if (batch.length > 0) {
        scenario = batch[0];
        if (batch.length > 1) enqueue('draft', batch.slice(1));
      }
    }

    if (!scenario) {
      return res.status(404).json({ error: `No scenarios for seniority=${seniority || 'any'} stage=${stage || 'any'}` });
    }

    const styleExamples = getPreferenceExamples('draft');
    const prompt = `Generate 3 different LinkedIn DM response options that WE would send to this lead. We are the outreach side (the platform described in your system prompt) — the lead is the recipient. Never invert this.

Each option should be distinctly different, human, casual, short (5-15 words for simple replies, max 2-3 lines for pitches).

SCENARIO:
Lead: ${scenario.lead.name} — ${scenario.lead.role}
Background: ${scenario.lead.background}
Stage: ${scenario.stage}
Context: ${scenario.context}
${scenario.lastMessage ? `Their message: "${scenario.lastMessage}"` : 'First outreach.'}
${styleExamples ? `\nMATCH THIS STYLE:\n${styleExamples}\n` : ''}

Return ONLY a JSON array of 3 strings. No markdown.`;

    const response = await claude.raw(prompt);
    let options;
    try {
      const match = response.match(/\[[\s\S]*\]/);
      options = match ? JSON.parse(match[0]) : [response];
    } catch { options = [response]; }

    res.json({ type: 'targeted', scenario, options, remaining: queueSize('draft') });
  } catch (err) {
    console.error('[Training] Targeted error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- SIMULATION MODE ----
// Auto-plays a conversation: Claude writes our message using the same retrieval
// + style-conditioning pipeline as production (router.js), then simulates the
// lead's reply. User can annotate, rate, or rewrite each of our messages.

// Build the guidance string (and a structured breakdown) used by the simulation
// drafter. Mirrors router.js as closely as possible so simulation == live:
//   1. Canonical avatar examples (★) + Q&A — highest priority, pulled from the
//      matrix cell that this turn classifies into.
//   2. Then fall back to scored preferences (corrections, annotations, ratings)
//      for context the matrix didn't cover.
// Returns { text, counts, breakdown, usedFallback } where breakdown is a
// structured object the dashboard can render in a "what fed this draft?" panel.
function buildSimGuidance(currentCtx, avatarId, leadProfile, lastInbound) {
  const wsId = workspace.getId();
  const prefs = store.getTrainingPreferences(wsId);
  const scored = prefs.map(p => ({ ...p, _score: scoreTrainingRelevance(p, currentCtx) }));
  const topByType = (type, max, requireScore = true) => {
    const filtered = scored.filter(p => p.type === type && (!requireScore || p._score > 0));
    // Sort by score first, then recency (timestamp desc) as tiebreaker
    filtered.sort((a, b) => (b._score - a._score) || (new Date(b.timestamp || 0) - new Date(a.timestamp || 0)));
    return filtered.slice(0, max);
  };

  // ---- Matrix-priority block: canonical examples + Q&A from the avatar cell ----
  let canonicalGood = [];
  let canonicalBad  = [];
  let qaPulled      = [];
  let canonicalSource = 'empty';
  if (avatarId) {
    try {
      const ex = avatars.getCanonicalExamples(wsId, avatarId, {
        limit: 3,
        lead: leadProfile || {},
        notes: (leadProfile && leadProfile.notes) || {},
      });
      canonicalGood = ex.good || [];
      canonicalBad  = ex.bad  || [];
      canonicalSource = ex.source || 'empty';
    } catch (err) {
      console.warn('[SimGuidance] getCanonicalExamples failed:', err.message);
    }
    if (looksLikeQuestion(lastInbound)) {
      try {
        qaPulled = avatars.findRelevantQAs(wsId, avatarId, lastInbound, { limit: 2 }) || [];
      } catch (err) {
        console.warn('[SimGuidance] findRelevantQAs failed:', err.message);
      }
    }
  }

  // ---- Scored-preferences block (existing logic) ----
  // Rewrites + annotations get larger slices — they're the strongest user signal.
  let corrections = topByType('correction', 10).filter(p => p.original);
  let styleOnly = topByType('draft', 5);
  let thumbsUp = topByType('thumbs_up', 5);
  let thumbsDown = topByType('thumbs_down', 5);
  let annotations = scored
    .filter(p => p.type === 'annotation' && p._score > 0 && p.selectedText && p.feedback)
    .sort((a, b) => b._score - a._score)
    .slice(0, 10);

  // Fallback: if NOTHING matched the context (and the avatar cell was also empty),
  // fall back to most-recent preferences so every simulation still reflects the
  // user's voice even when their trained scenarios don't overlap with this lead.
  const totalScored = corrections.length + styleOnly.length + thumbsUp.length + thumbsDown.length + annotations.length;
  const totalCanonical = canonicalGood.length + canonicalBad.length + qaPulled.length;
  let usedFallback = false;
  if (totalScored === 0 && totalCanonical === 0) {
    usedFallback = true;
    corrections = topByType('correction', 10, false).filter(p => p.original);
    styleOnly = topByType('draft', 5, false);
    thumbsUp = topByType('thumbs_up', 5, false);
    thumbsDown = topByType('thumbs_down', 5, false);
    annotations = scored
      .filter(p => p.type === 'annotation' && p.selectedText && p.feedback)
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
      .slice(0, 10);
  }

  const renderThread = (thread) => {
    const t = tailThread(thread);
    if (t.length === 0) return null;
    return t.map(m => `    [${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`).join('\n');
  };

  // ---- Compose the prompt text ----
  const blocks = [];

  // Canonical block at the TOP — highest priority. Same labelling as router.js
  // so Claude treats it identically across sim and live.
  if (canonicalGood.length || canonicalBad.length || qaPulled.length) {
    const renderCanonical = (e) => {
      if (e.type === 'correction' && e.original) return `  BAD:  "${e.original}"\n  GOOD: "${e.text}"`;
      if (e.type === 'annotation' && e.selectedText) return `  In "${e.text}", phrase "${e.selectedText}" → ${e.feedback || '(no feedback)'}`;
      return `  "${e.text}"`;
    };
    const goodStr = canonicalGood.length ? canonicalGood.map(renderCanonical).join('\n\n') : '';
    const badStr  = canonicalBad.length  ? canonicalBad.map(renderCanonical).join('\n\n')  : '';
    const qaStr   = qaPulled.length
      ? qaPulled.map(qa => `  Q: "${qa.question}"\n  A: "${qa.answer}"${qa.isCanonical ? ' (★ canonical)' : ''} [match: ${qa.score}]`).join('\n\n')
      : '';
    blocks.push(`\n=== CANONICAL EXAMPLES FOR THIS AVATAR (${avatarId}, source: ${canonicalSource}) ===\nThese are the highest-signal examples for THIS exact context. Mimic the GOOD ones in shape and rhythm; never write like the BAD ones.${qaStr ? `\n\nQ&A REFERENCE — the lead's last message looks like a question. Closest answered questions for this context (use the answer style, adapt to their exact wording):\n${qaStr}` : ''}${goodStr ? `\n\nGOOD (write like these):\n${goodStr}` : ''}${badStr ? `\n\nBAD (never write like these):\n${badStr}` : ''}`);
  }

  if (corrections.length) {
    blocks.push(`\nREWRITES — THESE CARRY THE MOST WEIGHT. Never write like the BAD version, always match the GOOD version's approach. Each shows the conversation that preceded the correction:\n${corrections.map(p => {
      const ctx = renderThread(p.thread);
      return ctx
        ? `  After this exchange:\n${ctx}\n    BAD: "${p.original}" → GOOD: "${p.chosen}"`
        : `  BAD: "${p.original}" → GOOD: "${p.chosen}"`;
    }).join('\n\n')}`);
  }
  if (annotations.length) {
    blocks.push(`\nPHRASE-LEVEL FEEDBACK — user highlighted specific phrases and commented. These also carry heavy weight, respect the feedback precisely:\n${annotations.map(p => {
      const ctx = renderThread(p.thread);
      const core = `    In the message "${p.chosen}", the phrase "${p.selectedText}" was marked ${p.rating === 'good' ? 'GOOD' : 'BAD'}: ${p.feedback}`;
      return ctx ? `  After this exchange:\n${ctx}\n${core}` : core;
    }).join('\n\n')}`);
  }
  if (styleOnly.length) {
    blocks.push(`\nSTYLE EXAMPLES (match tone and length):\n${styleOnly.map(p => {
      const ctx = renderThread(p.thread);
      return ctx
        ? `  After this exchange:\n${ctx}\n    US wrote: "${p.chosen}"`
        : `  "${p.chosen}"`;
    }).join('\n\n')}`);
  }
  if (thumbsUp.length) {
    blocks.push(`\nGOOD DRAFTS (rated + by the user — write more like these):\n${thumbsUp.map(p => {
      const ctx = renderThread(p.thread);
      return ctx
        ? `  After this exchange:\n${ctx}\n    US wrote (marked GOOD): "${p.chosen}"`
        : `  "${p.chosen}"`;
    }).join('\n\n')}`);
  }
  if (thumbsDown.length) {
    blocks.push(`\nBAD DRAFTS (rated − by the user — never write like these):\n${thumbsDown.map(p => {
      const ctx = renderThread(p.thread);
      return ctx
        ? `  After this exchange:\n${ctx}\n    US wrote (marked BAD): "${p.chosen}"`
        : `  "${p.chosen}"`;
    }).join('\n\n')}`);
  }
  const text = blocks.length ? blocks.join('\n') : null;

  // ---- Structured breakdown: same data the prompt uses, but as JSON the
  // dashboard can render in the "what fed this draft?" panel.
  const breakdown = {
    avatarId: avatarId || null,
    canonicalSource,
    canonicalGood: canonicalGood.map(e => ({ text: e.text, original: e.original || '', type: e.type, isCanonical: !!e.isCanonical, feedback: e.feedback || '', selectedText: e.selectedText || '' })),
    canonicalBad:  canonicalBad.map(e =>  ({ text: e.text, original: e.original || '', type: e.type, isCanonical: !!e.isCanonical, feedback: e.feedback || '', selectedText: e.selectedText || '' })),
    qa: qaPulled.map(qa => ({ question: qa.question, answer: qa.answer, score: qa.score, isCanonical: !!qa.isCanonical, source: qa.source })),
    corrections: corrections.map(p => ({ original: p.original, chosen: p.chosen, threadTail: tailThread(p.thread) })),
    annotations: annotations.map(p => ({ chosen: p.chosen, selectedText: p.selectedText, feedback: p.feedback, rating: p.rating, threadTail: tailThread(p.thread) })),
    style:       styleOnly.map(p => ({ chosen: p.chosen, threadTail: tailThread(p.thread) })),
    thumbsUp:    thumbsUp.map(p => ({ chosen: p.chosen, threadTail: tailThread(p.thread) })),
    thumbsDown:  thumbsDown.map(p => ({ chosen: p.chosen, threadTail: tailThread(p.thread) })),
    usedFallback,
    lastInboundLooksLikeQuestion: looksLikeQuestion(lastInbound),
  };

  return {
    text,
    counts: {
      canonicalGood: canonicalGood.length,
      canonicalBad:  canonicalBad.length,
      qa:            qaPulled.length,
      corrections:   corrections.length,
      style:         styleOnly.length,
      thumbsUp:      thumbsUp.length,
      thumbsDown:    thumbsDown.length,
      annotations:   annotations.length,
      totalPrefs:    prefs.length,
    },
    breakdown,
    usedFallback,
  };
}

function nextSimStage(thread) {
  const ourCount = thread.filter(m => m.sender === 'us').length;
  if (ourCount === 0) return 'cold_opener';
  if (ourCount === 1) return 'natural_response';
  if (ourCount === 2) return 'value_pitch';
  return 'close';
}

async function simulateLeadReply(lead, thread) {
  const threadStr = thread.map(m => `[${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`).join('\n');
  // ourMessageCount lets the prompt vary "ghost" probability with conversation
  // depth — leads ghost more after our 2nd / 3rd / 4th message than after our 1st.
  const ourMessageCount = thread.filter(m => m.sender === 'us').length;
  const prompt = `You are simulating a realistic LinkedIn lead for stress-testing an outreach system. Play the lead — and be a HARD lead. Most people on LinkedIn don't care, are busy, and are skeptical of DMs from strangers. Reflect that.

LEAD PROFILE:
Name: ${lead.name}
Role: ${lead.role}
Background: ${lead.background || ''}
${lead.location ? `Location: ${lead.location}` : ''}

CONVERSATION SO FAR:
${threadStr}

OUR MESSAGES SO FAR: ${ourMessageCount}

THREE POSSIBLE OUTCOMES — pick the most realistic one:

1. REPLY ({ "reply": "...", "ended": false }) — you respond.
   - MAXIMUM 12 words. Most replies 3-8 words. One-liners, fragments, no punctuation sometimes.
   - Tone: skeptical, guarded, busy, sometimes dismissive or slightly annoyed. Not hostile — just realistic.
   - Never thank, never apologize, never be enthusiastic.
   - Push back, ask hard questions, express doubt. "What exactly is this", "Not sure", "Doesn't seem relevant", "Already have something", "Why should I care".
   - Roughly 60% of replies should be negative / skeptical / brief. 30% neutral-curious. 10% warm.

2. SILENT ({ "silent": true, "ended": false }) — you READ the message but don't reply (yet).
   - Use this when the message is mid-pitch, mildly interesting but not enough to commit, or asks for something effortful.
   - Probability scales with depth: ~10% after our 1st message, ~30% after our 2nd, ~40% after our 3rd+.
   - This is the MOST COMMON real-LinkedIn outcome at mid-funnel — quietly read, nothing to say back yet.
   - The system will offer the user a chance to send a follow-up nudge; you do NOT pre-write that follow-up.

3. ENDED ({ "reply": "not interested" / similar, "ended": true }) — you reject and stop.
   - Use only for clear rejection ("not interested", "stop messaging", explicit no).
   - Or for explicit agreement ("send the link" — rare; only if outreach was genuinely compelling).
   - Don't use this just because you're bored — use SILENT for that.

Return ONLY valid JSON, no markdown:
{ "reply": "...", "ended": false }   (option 1)
{ "silent": true, "ended": false }   (option 2)
{ "reply": "...", "ended": true }    (option 3)`;

  const raw = await claude.raw(prompt);
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { reply: raw, ended: false };
    const parsed = JSON.parse(match[0]);
    // Normalize: guard against the model returning silent:true with a stray reply
    if (parsed.silent === true) return { reply: null, silent: true, ended: false };
    return parsed;
  } catch {
    return { reply: raw, ended: false };
  }
}

// Synthesize a plausible prior conversation thread that ends with the lead in
// the given stage. Returns an array of { sender, text } messages ready to be
// loaded into simThread. We need this because:
//   - Cold opener simulations start naturally from an empty thread.
//   - Mid-conversation stages (value_pitch / objection / close / follow_up)
//     require a prior thread for classifyAvatar + the lead simulator + the
//     drafter to behave correctly. Without it, the next turn would re-classify
//     as cold_opener and the matrix cells the user expected to fill (e.g.
//     analyst × follow_up × follow_up_after_ghosting) would never get any data.
// We use Claude (cheap, one call) so threads sound real, then the simulator
// takes over from there.
async function synthesizeStarterThread({ scenario, leadProfile, targetStage, targetSituation }) {
  const stage = targetStage || scenario?.stage || 'cold_opener';
  // For cold_opener with a specific situation we still want a *zero-message*
  // thread — the cold opener IS our first message. Situation steering for
  // cold_opener happens via the inbound the lead generates AFTER our opener,
  // not via the prior thread (since there is none).
  if (stage === 'cold_opener') return [];

  // Map of stage → what the prior thread should look like.
  const beat = ({
    value_pitch: 'A short cold opener from us, then a brief curious-but-skeptical reply from them. Stop there — the next turn will be our value pitch.',
    natural_response: 'A cold opener from us, a brief reply from them, our short follow-up question. Stop there — the next turn is a casual in-flow exchange.',
    objection: 'A cold opener from us, brief reply, our value pitch with a soft mention of what we offer, then their objection (price / time / fit / "already have something"). Stop there — the next turn is our objection handling.',
    close: 'A cold opener from us, brief reply, our value pitch, their interested follow-up, our hook about the next step, then their explicit buying signal ("how do I sign up", "send me the link", "how much"). Stop there — the next turn is our close.',
    follow_up: 'A cold opener from us, brief reply from them, our value pitch with a clear hook (e.g. mentioned a curated list). The lead READ but did not reply. The next turn is our 24h follow-up nudge.',
    follow_up_after_ghosting: 'A cold opener from us, brief reply, our value pitch. Lead read it but did not reply. Next turn is our follow-up nudge.',
  })[stage] || 'A short cold opener from us and a brief reply from them.';

  // Situation steer — describes WHAT the lead's last reply must signal so the
  // avatar classifier lands the next turn in the target cell. Each entry is
  // an instruction the LLM appends to the synthesized thread's last 'them' turn.
  // Skipped (or set to neutral) for follow_up_after_ghosting since that situation
  // implies the lead went silent (no last message to shape).
  const situationSteer = ({
    neutral:                   'Last lead message: a flat, short non-committal reply ("ok", "what is this", "go on") — no objection, no buying signal.',
    curious:                   'Last lead message: clearly curious — they ask what it is, how it works, or what kinds of roles ("how does it work", "what kind of roles", "what is on the list").',
    price_objection:           'Last lead message: a clear price/cost objection ("how much", "is it free", "sounds expensive", "can\'t pay for this", "is there a free version"). Use everyday phrasing — short, busy, slightly skeptical.',
    time_objection:            'Last lead message: a clear time/bandwidth objection ("super busy", "no time right now", "exam period", "maybe later", "ping me in a few months"). Short, busy.',
    confidentiality_objection: 'Last lead message: a clear confidentiality / discretion concern ("would my firm see this", "is this confidential", "can\'t have my company find out", "discreet?"). Short, anxious.',
    has_alternative:           'Last lead message: signals they already have a similar source ("I have a network", "already use X", "covered, thanks", "have an in"). Short.',
    buying_signal:             'Last lead message: explicit buying intent ("send me the list", "let\'s do it", "how do I start", "send the link", "sign me up"). Short, decisive.',
    frustrated:                'Last lead message: annoyed / hostile / accusatory ("stop messaging", "this is spam", "why are you DMing me", "not interested, leave me alone"). Sharp, short.',
    follow_up_after_ghosting:  '', // handled by stage beat — lead does not reply at all.
    wants_intro_to_specific_firm: 'Last lead message: names a SPECIFIC firm and asks for help with that firm in particular ("any roles at Goldman?", "do you cover Citadel?", "introductions at PJT?"). Names the firm explicitly.',
  })[targetSituation || ''] || '';

  // VOICE REFERENCE — pull canonical good examples from the seniority's most-trained
  // upstream cells so the synthesized US turns sound like the user's actual voice
  // instead of generic Claude. Without this, a user with 20+ trained openers still
  // gets a bootstrap thread that doesn't match their style — making the trainable
  // turn (which DOES use canonical retrieval) feel disconnected from its setup.
  const wsId = workspace.getId();
  const seniority = leadProfile.seniority || 'unknown';
  const voiceTurns = []; // { position, text }
  const positionsToPull = [];
  // Every prior thread starts with our cold_opener — pull voice from there.
  positionsToPull.push('cold_opener');
  // Stages that include a value pitch in the buildup also need pitch voice.
  if (['value_pitch', 'close', 'objection', 'follow_up', 'follow_up_after_ghosting'].includes(stage)) {
    positionsToPull.push('value_pitch');
  }
  for (const pos of positionsToPull) {
    try {
      const ex = avatars.getCanonicalExamples(
        wsId,
        avatars.makeAvatarId(seniority, pos, 'neutral'),
        { limit: 3, lead: leadProfile, notes: leadProfile.notes || {} },
      );
      for (const e of (ex.good || [])) voiceTurns.push({ position: pos, text: e.text });
    } catch (err) {
      console.warn(`[Synthesis] voice pull failed for ${seniority}__${pos}__neutral:`, err.message);
    }
  }
  const voiceBlock = voiceTurns.length
    ? `\n=== VOICE REFERENCE (CRITICAL) ===
The user has trained these canonical examples for ${seniority}. Match this voice EXACTLY in any "us" turns you produce — sentence length, opening pattern, vocabulary, register, contractions, punctuation. Do NOT copy the text verbatim, do NOT invent a different voice, do NOT default to generic outreach phrasing. The whole point of this synthesis is that the trainable turn is anchored to setup that matches the user's real outbound style.

${voiceTurns.map(t => `  [${t.position}] "${t.text}"`).join('\n')}
`
    : '';

  const prompt = `You are bootstrapping a realistic LinkedIn DM training scenario by synthesizing the conversation that LED UP TO this stage. Return a short prior thread.

LEAD: ${leadProfile.name} — ${leadProfile.role}${leadProfile.company ? ` at ${leadProfile.company}` : ''}${leadProfile.location ? `, ${leadProfile.location}` : ''}
${leadProfile.summary ? `Background: ${leadProfile.summary}` : ''}
TARGET STAGE: ${stage}
${targetSituation ? `TARGET SITUATION: ${targetSituation}` : ''}

WHAT THE THREAD SHOULD CONTAIN: ${beat}
${situationSteer ? `\nIMPORTANT — situation steer (this is the WHOLE point of the scenario, must land precisely):\n${situationSteer}` : ''}
${voiceBlock}
STYLE RULES:
- Realistic LinkedIn DMs, short, casual-professional. Lead is busy and slightly skeptical.
- Our messages MUST match the VOICE REFERENCE above when one is provided. If the reference shows short fragments, use short fragments. If it leads with a specific framing ("student here", "built X"), use that framing.
- NEVER mention pricing.
- NEVER output bracketed placeholder tokens like [booking_link], [payment_link], or anything in [square_brackets_with_underscores]. If a link belongs in the message, describe it naturally instead.
- Lead replies are 3-12 words, fragments allowed. The lead does NOT instantly become convinced — they stay skeptical, busy, slightly dismissive across multiple turns.
- 2 to 4 messages total (alternating us/them).
- Do NOT include the next turn (which is what the simulation will generate).

Return ONLY a JSON array of messages, no preamble:
[{"sender": "us", "text": "..."}, {"sender": "them", "text": "..."}, ...]`;

  try {
    // Bump to Sonnet for synthesis: one call per simulation start, ~$0.005, and
    // voice fidelity matters. Haiku at this prompt size produced generic openers
    // that ignored canonical examples even when they were provided.
    const raw = await claude.raw(prompt, { model: claude.SONNET, temperature: 0.5 });
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(m => m && (m.sender === 'us' || m.sender === 'them') && typeof m.text === 'string' && m.text.trim())
      // _synthesized flag tells the dashboard these are bootstrap context, not
      // user-trained turns — no rate / rewrite / annotate buttons should be
      // shown on them, since the user isn't endorsing them.
      .map(m => ({ sender: m.sender, text: m.text.trim(), _synthesized: true }));
  } catch (err) {
    console.warn('[Simulation] starter thread synthesis failed:', err.message);
    return [];
  }
}

// POST /training/simulation/start
// body: { seniority?, stage?, situation? } — picks or generates a matching
// scenario, and for non-cold-opener stages also synthesizes the prior thread
// so the next turn's classifyAvatar lands in the correct matrix cell.
//
// When `situation` is provided, the synthesized thread is steered so the
// lead's LAST reply explicitly signals that situation (e.g. price_objection
// → "is it free?"). For cold_opener + non-neutral situation, we cannot
// pre-load a thread (cold_opener has none), so the dashboard's auto-fill
// flow should target stages that come after a turn or two of dialog.
router.post('/simulation/start', async (req, res) => {
  const { seniority, stage, situation } = req.body || {};
  try {
    initQueues();
    let scenario;
    if (seniority || stage) {
      // When a situation is targeted we DON'T reuse a queued scenario — queued
      // scenarios were generated without situation context and would re-bias
      // simulations toward whatever situation they happen to land in. Always
      // generate fresh for situation-targeted flows.
      const idx = situation ? -1 : queues.draft.findIndex(s =>
        (!seniority || s.seniority === seniority) && (!stage || s.stage === stage)
      );
      if (idx >= 0) {
        scenario = queues.draft.splice(idx, 1)[0];
      } else {
        const batch = await generateTargetedBatch(seniority, stage, situation);
        if (batch.length > 0) {
          scenario = batch[0];
          // Don't pollute the generic draft queue with situation-specific
          // scenarios — they should only be used for the targeted run.
          if (batch.length > 1 && !situation) enqueue('draft', batch.slice(1));
        }
      }
    } else {
      scenario = dequeue('draft');
      if (!scenario) {
        const batch = await generateDraftBatch();
        enqueue('draft', batch);
        scenario = dequeue('draft');
      }
    }
    if (!scenario) return res.status(404).json({ error: 'No scenario available for those filters' });

    // Synthesize a prior thread for non-cold-opener stages so the simulation
    // starts in the right place. Returns [] for cold_opener (which is the
    // existing behavior).
    const targetStage = scenario.stage || stage || 'cold_opener';
    const targetSituation = situation || null;
    const leadProfile = {
      name: scenario.lead?.name,
      role: scenario.lead?.role,
      company: scenario.lead?.company || '',
      location: scenario.lead?.location || '',
      summary: scenario.lead?.background || '',
      seniority: scenario.seniority || seniority || 'unknown',
    };
    const starterThread = await synthesizeStarterThread({
      scenario, leadProfile, targetStage, targetSituation,
    });

    // Compute the target avatar id so the front-end can compare the
    // post-classification avatar and offer a "relabel" if Haiku disagrees.
    const targetAvatarId = (seniority || scenario.seniority) && targetStage && targetSituation
      ? avatars.makeAvatarId(scenario.seniority || seniority || 'unknown', targetStage, targetSituation)
      : null;

    res.json({
      lead: scenario.lead,
      seniority: scenario.seniority || seniority || 'unknown',
      stage: targetStage,
      situation: targetSituation,
      targetAvatarId,
      scenario,
      // Empty for cold_opener; populated for value_pitch / objection / close / follow_up
      // so the dashboard can preload simThread before the user clicks "Next turn".
      thread: starterThread,
    });
  } catch (err) {
    console.error('[Training] Simulation start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /training/simulation/step
// body: { lead, seniority, thread, skipLeadReply? }
//   - returns the next our-message generated from the current thread + guidance
//   - if skipLeadReply is true, does NOT generate the lead's response
//     (caller hits /simulation/lead-reply separately, after the user reviews
//     / rewrites / edits the our-message and the thread). This is the
//     two-step flow the dashboard uses by default — guarantees the lead's
//     simulated reply considers any rewrite the user just made.
router.post('/simulation/step', async (req, res) => {
  const { lead, seniority, thread, skipLeadReply, targetAvatarId } = req.body || {};
  if (!lead) return res.status(400).json({ error: 'lead required' });
  const safeThread = Array.isArray(thread) ? thread : [];
  const targetParsed = targetAvatarId ? avatars.parseAvatarId(targetAvatarId) : null;
  const targetSituation = targetParsed?.situation || null;

  try {
    const toneGuess = classifySeniority(lead.role, lead.background || '', '').tone;
    // Simulation uses credits=15 so the full close flow (payment link) is reachable
    // — otherwise the payment-link gate in assets.js always falls back to trial.
    const leadProfile = {
      name: lead.name,
      role: lead.role,
      company: lead.company || '',
      location: lead.location || '',
      summary: lead.background || '',
      seniority: seniority || 'unknown',
      seniorityTone: toneGuess,
      lastAssetSent: null,
      creditsUsed: 15,
      creditsTotal: 20,
    };

    // If the lead has replied at least once, run the real routing classifier so stage
    // + routing decision come from conversation content — not a message counter.
    let routingDecision;
    const hasInbound = safeThread.some(m => m.sender === 'them');
    if (hasInbound) {
      try {
        routingDecision = await claude.classifyAndRoute(safeThread, leadProfile);
      } catch (e) {
        console.warn('[Simulation] classifyAndRoute failed, using fallback:', e.message);
        const fallbackStage = nextSimStage(safeThread);
        routingDecision = {
          funnel_stage: fallbackStage, stage: fallbackStage,
          intent: 'engaged, exploring', next_objection: '', routing_decision: 'no_action',
          sentiment: '', suggested_asset_segment: 'general', is_follow_up: false,
        };
      }
    } else {
      // First turn — no inbound yet, synthesize a cold_opener decision
      routingDecision = {
        funnel_stage: 'cold_opener', stage: 'cold_opener',
        intent: 'unknown — no prior reply', next_objection: '',
        routing_decision: 'no_action', sentiment: '',
        suggested_asset_segment: 'general', is_follow_up: false,
      };
    }

    const stage = routingDecision.funnel_stage || 'natural_response';
    const assetSegment = routingDecision.suggested_asset_segment || 'general';
    const selectedAsset = assets.selectAsset(routingDecision.routing_decision, assetSegment, leadProfile.creditsUsed);

    const currentCtx = {
      seniority: leadProfile.seniority,
      funnelStage: stage,
      sentiment: routingDecision.sentiment || '',
      assetSegment,
      role: leadProfile.role,
      company: leadProfile.company,
      location: leadProfile.location,
      nextObjection: routingDecision.next_objection || '',
      intent: routingDecision.intent || '',
      routingDecision: routingDecision.routing_decision || '',
    };

    // Classify the avatar this turn lands in. One Haiku call (~$0.0001), cached
    // briefly per-conversation by the avatars module. The avatarId becomes the
    // matrix cell that (a) feeds canonical examples + Q&A into this draft and
    // (b) gets stamped onto every save the user makes on the resulting message.
    let avatarId = null;
    try {
      const cls = await avatars.classifyAvatar(safeThread, leadProfile, routingDecision);
      avatarId = cls.avatarId;
    } catch (err) {
      console.warn('[Simulation] classifyAvatar failed, proceeding without matrix data:', err.message);
    }

    const lastInbound = [...safeThread].reverse().find(m => m.sender === 'them')?.text || '';
    const guidance = buildSimGuidance(currentCtx, avatarId, leadProfile, lastInbound);

    // Anti-repetition: collect the last 5 'us' drafts written in THIS cell so
    // Claude won't recycle the same opener. We dedupe by exact opener (first
    // ~8 words) — same prefix = repeat. Pulled from store, not the live thread,
    // so it covers prior simulation runs of the same cell, not just this one.
    const cellAvatar = targetAvatarId || avatarId;
    let avoidOpeners = [];
    if (cellAvatar) {
      const recentDrafts = store.getTrainingPreferences(workspace.getId())
        .filter(p => p.avatar === cellAvatar && p.chosen && (p.type === 'draft' || p.type === 'thumbs_up' || p.type === 'thumbs_down' || p.type === 'correction'))
        .slice(-5)
        .map(p => p.chosen);
      // Take just the first ~12 words of each so the prompt stays short and
      // Claude treats it as an opener-shape match rather than full-text dedup.
      avoidOpeners = recentDrafts
        .map(t => String(t).trim().split(/\s+/).slice(0, 12).join(' '))
        .filter(Boolean);
    }

    console.log(`[Simulation] stage=${stage} avatar=${avatarId || 'none'} target=${targetAvatarId || 'none'} route=${routingDecision.routing_decision} asset=${selectedAsset?.id || 'none'} seniority=${leadProfile.seniority} avoidOpeners=${avoidOpeners.length} — pulled: canonical+=${guidance.counts.canonicalGood} canonical-=${guidance.counts.canonicalBad} qa=${guidance.counts.qa} corrections=${guidance.counts.corrections} style=${guidance.counts.style} thumbs+=${guidance.counts.thumbsUp} thumbs-=${guidance.counts.thumbsDown} annotations=${guidance.counts.annotations} fallback=${guidance.usedFallback} (of ${guidance.counts.totalPrefs} total)`);
    const ourMessage = (await claude.draftMessage(safeThread, leadProfile, routingDecision, selectedAsset, guidance.text, { temperature: 0.85, avoidOpeners })).trim();

    // Classifier mismatch: when the auto-fill flow targets a specific avatar
    // (e.g. analyst × value_pitch × price_objection) but Haiku classifies this
    // turn into a different cell, surface that to the dashboard so the user can
    // either relabel before saving or restart the scenario.
    const classifierMismatch = !!(targetAvatarId && avatarId && avatarId !== targetAvatarId);

    // Two-step flow: when the dashboard wants to pause for user review/rewrite
    // before the lead replies, it sends skipLeadReply=true. The lead reply
    // then comes from a separate /simulation/lead-reply call after any edits.
    if (skipLeadReply) {
      return res.json({
        ourMessage,
        theirReply: null,
        ended: false,
        silent: false,
        paused: true,            // signals dashboard: AI message generated, waiting for user to confirm before lead reply
        stage,
        avatarId,
        targetAvatarId: targetAvatarId || null,
        classifierMismatch,
        usedGuidance: !!guidance.text,
        guidanceCounts: guidance.counts,
        guidanceBreakdown: guidance.breakdown,
        usedFallback: guidance.usedFallback,
      });
    }

    const threadWithOurs = [...safeThread, { sender: 'us', text: ourMessage }];
    const leadOutcome = await simulateLeadReply(lead, threadWithOurs);
    // Deterministic silent override. The model under-uses the silent option
    // even when prompted, so we enforce realistic ghosting rates ourselves:
    // after our 2nd message, 40% chance the lead "ghosts" (silent), and after
    // our 3rd+ message it's 50%. Skipped when the model said the lead is
    // ending the convo (don't overwrite a clear rejection / agreement).
    //
    // ⚠ Gated for targeted-coverage runs: when the auto-fill flow is targeting
    // a non-ghost situation, we MUST NOT force the lead silent — that would
    // funnel the resulting save into follow_up_after_ghosting and skip the
    // intended cell. Only the legacy free-form simulation (no targetAvatarId)
    // and the explicit follow-up-after-ghosting target get the override.
    const ourMsgCount = threadWithOurs.filter(m => m.sender === 'us').length;
    const allowForceSilent = !targetSituation || targetSituation === 'follow_up_after_ghosting';
    const ghostProbability = !allowForceSilent ? 0
      : ourMsgCount >= 3 ? 0.5
      : ourMsgCount >= 2 ? 0.4
      : 0;
    const forceSilent = !leadOutcome.ended && Math.random() < ghostProbability;
    const isSilent = !!leadOutcome.silent || forceSilent;
    if (forceSilent) {
      console.log(`[Simulation] Force-silent triggered (our msg #${ourMsgCount}, p=${ghostProbability}, target=${targetSituation || 'none'}) — model returned ${leadOutcome.silent ? 'silent' : 'reply'}`);
    }

    res.json({
      ourMessage,
      // theirReply is null when silent (read but didn't respond) — the dashboard
      // surfaces a "Lead didn't reply, send a follow-up?" pop-up in that case.
      theirReply: isSilent ? null : (leadOutcome.reply || null),
      ended: !!leadOutcome.ended,
      silent: isSilent,
      stage,
      avatarId,
      targetAvatarId: targetAvatarId || null,
      classifierMismatch,
      usedGuidance: !!guidance.text,
      guidanceCounts: guidance.counts,
      guidanceBreakdown: guidance.breakdown,
      usedFallback: guidance.usedFallback,
    });
  } catch (err) {
    console.error('[Training] Simulation step error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /training/simulation/lead-reply
// body: { lead, thread } — generates ONLY the lead's response to the latest
// state of the thread. Used by the two-step simulation flow: after the user
// reviews / rewrites our message (and optionally edits a prior them message),
// the dashboard calls this endpoint so the lead reply considers the user's
// changes. Same silent / ended / forced-ghost logic as /simulation/step's
// integrated path.
router.post('/simulation/lead-reply', async (req, res) => {
  const { lead, thread } = req.body || {};
  if (!lead) return res.status(400).json({ error: 'lead required' });
  const safeThread = Array.isArray(thread) ? thread : [];
  if (safeThread.length === 0 || safeThread[safeThread.length - 1].sender !== 'us') {
    return res.status(400).json({ error: 'lead-reply requires the most recent message in the thread to be from us' });
  }
  try {
    const leadOutcome = await simulateLeadReply(lead, safeThread);
    const ourMsgCount = safeThread.filter(m => m.sender === 'us').length;
    const ghostProbability = ourMsgCount >= 3 ? 0.5 : ourMsgCount >= 2 ? 0.4 : 0;
    const forceSilent = !leadOutcome.ended && Math.random() < ghostProbability;
    const isSilent = !!leadOutcome.silent || forceSilent;
    res.json({
      theirReply: isSilent ? null : (leadOutcome.reply || null),
      ended: !!leadOutcome.ended,
      silent: isSilent,
    });
  } catch (err) {
    console.error('[Training] Simulation lead-reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /training/simulation/ghost
// Simulates a realistic LinkedIn scenario: lead READ the message, didn't reply for 24h
// → we send a follow-up. Forces funnel_stage='follow_up' + situation='follow_up_after_ghosting'
// so the resulting training records auto-tag into the right avatar cell.
// Body: { lead, seniority, thread } — same shape as /simulation/step
router.post('/simulation/ghost', async (req, res) => {
  const { lead, seniority, thread } = req.body || {};
  if (!lead) return res.status(400).json({ error: 'lead required' });
  const safeThread = Array.isArray(thread) ? thread : [];
  const lastTurnIsOurs = safeThread.length > 0 && safeThread[safeThread.length - 1].sender === 'us';
  if (!lastTurnIsOurs) {
    return res.status(400).json({ error: 'Ghosting only makes sense after WE sent a message — last turn must be from "us"' });
  }

  try {
    const toneGuess = classifySeniority(lead.role, lead.background || '', '').tone;
    const leadProfile = {
      name: lead.name,
      role: lead.role,
      company: lead.company || '',
      location: lead.location || '',
      summary: lead.background || '',
      seniority: seniority || 'unknown',
      seniorityTone: toneGuess,
      lastAssetSent: null,
      creditsUsed: 15,
      creditsTotal: 20,
    };

    // Force avatar context: follow_up_after_ghosting
    const routingDecision = {
      funnel_stage:           'follow_up',
      stage:                  'follow_up',
      intent:                 'lead read our last message but went silent for 24h — gentle nudge',
      next_objection:         '',
      routing_decision:       'follow_up_ai',
      sentiment:              'neutral',
      suggested_asset_segment: 'general',
      is_follow_up:           true,
      situation:              'follow_up_after_ghosting',
    };

    const currentCtx = {
      seniority:        leadProfile.seniority,
      funnelStage:      'follow_up',
      sentiment:        'neutral',
      assetSegment:     'general',
      role:             leadProfile.role,
      company:          leadProfile.company,
      location:         leadProfile.location,
      nextObjection:    '',
      intent:           'follow up after silence',
      routingDecision:  'follow_up_ai',
      situation:        'follow_up_after_ghosting',
    };

    // Avatar is fixed for ghosting — we know the cell deterministically, so we
    // don't need a Haiku call. Just synthesize the id from the known axes.
    const avatarId = avatars.makeAvatarId(
      leadProfile.seniority || 'unknown',
      'follow_up',
      'follow_up_after_ghosting',
    );
    const lastInbound = [...safeThread].reverse().find(m => m.sender === 'them')?.text || '';
    const guidance = buildSimGuidance(currentCtx, avatarId, leadProfile, lastInbound);
    console.log(`[Simulation/Ghost] seniority=${leadProfile.seniority} avatar=${avatarId} — pulled: canonical+=${guidance.counts.canonicalGood} canonical-=${guidance.counts.canonicalBad} qa=${guidance.counts.qa} corrections=${guidance.counts.corrections} style=${guidance.counts.style} thumbs+=${guidance.counts.thumbsUp} thumbs-=${guidance.counts.thumbsDown}`);
    const ourMessage = (await claude.draftMessage(safeThread, leadProfile, routingDecision, null, guidance.text)).trim();

    res.json({
      ourMessage,
      theirReply: null,
      ended: false,
      stage: 'follow_up',
      situation: 'follow_up_after_ghosting',
      avatarId,
      ghosted: true,
      timeElapsed: '24h since last message',
      usedGuidance: !!guidance.text,
      guidanceCounts: guidance.counts,
      guidanceBreakdown: guidance.breakdown,
      usedFallback: guidance.usedFallback,
    });
  } catch (err) {
    console.error('[Training] Simulation ghost error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /training/preferences
router.get('/preferences', (req, res) => {
  const wsId = workspace.getId();
  const prefs = store.getTrainingPreferences(wsId);
  res.json({ workspace: wsId, preferences: prefs, total: prefs.length });
});

// GET /training/sync-status — how many in-memory records have not yet been
// pushed to Airtable. Dashboard polls this so it can show a banner like
// "12 records pending Airtable sync — Resync now".
router.get('/sync-status', (req, res) => {
  const pending = store.getPendingTrainingSyncCount();
  res.json({ pending, hasAirtable: !!process.env.AIRTABLE_API_KEY });
});

// POST /training/force-resync — push every in-memory training record that
// lacks an airtableId up to Airtable. Used to recover from machine-portability
// gaps (training was done on a machine without Airtable creds, or Airtable was
// rate-limited / down during the original save). Idempotent: records that
// already have an airtableId are skipped.
router.post('/force-resync', async (req, res) => {
  try {
    const result = await store.forceResyncTrainingToAirtable();
    console.log(`[Training] Force resync: pushed ${result.pushed}, failed ${result.failed} of ${result.totalPending} pending`);
    res.json(result);
  } catch (err) {
    console.error('[Training] Force resync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /training/preferences
router.delete('/preferences', (req, res) => {
  store.clearTrainingPreferences();
  res.json({ success: true });
});

module.exports = router;
