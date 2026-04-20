// src/routes/training.js
const express = require('express');
const router = express.Router();
const store = require('../services/store');
const claude = require('../services/claude');
const workspace = require('../services/workspace');
const { scoreTrainingRelevance, classifySeniority } = require('../services/router');

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
router.post('/preference', (req, res) => {
  const { type, scenario, chosen, original, optionIndex, isCustom, source } = req.body;
  if (!chosen) return res.status(400).json({ error: 'chosen required' });

  const pref = { type: type || 'draft', scenario, chosen, optionIndex, isCustom, source: source || 'training', timestamp: new Date().toISOString() };
  if (original) pref.original = original;
  store.addTrainingPreference(pref);
  const total = store.getTrainingPreferences().length;
  console.log(`[Training] ${type || 'draft'} preference recorded (${total} total)${original ? ' [correction]' : ''}`);
  res.json({ success: true, totalPreferences: total });
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
  const byType = { conversation: 0, targeted: 0, draft: 0, sentiment: 0, routing: 0 };
  prefs.forEach(p => {
    const src = p.source || 'training';
    if (src === 'conversation') byType.conversation++;
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
router.post('/annotate', (req, res) => {
  const { scenario, optionText, selectedText, feedback, rating, source } = req.body;
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
  store.addTrainingPreference(annotation);
  console.log(`[Training] Annotation: "${selectedText}" → ${rating} (${feedback.substring(0, 50)})`);
  res.json({ success: true });
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

// Generate scenarios for a specific seniority/stage combo
async function generateTargetedBatch(seniority, stage) {
  const ws = workspace.get();
  const excludeNames = usedLeadNames().slice(-30).join(', ');
  const pastPrefs = store.getTrainingPreferences(workspace.getId())
    .filter(p => p.type === 'draft' && p.scenario?.seniority === seniority)
    .slice(-10)
    .map(p => `Stage: ${p.scenario?.stage}, Chosen: "${p.chosen}"`)
    .join('\n');

  const prompt = `Generate 4 LinkedIn DM training scenarios for ${ws.company?.name || 'a high-finance career platform'}.

The platform: ${ws.company?.what_it_is || 'curated high-finance roles + application support'}

ALL scenarios MUST have:
- seniority: "${seniority || 'analyst'}"
- stage: "${stage || 'value_pitch'}"

DO NOT reuse these names: ${excludeNames}

Each needs: stage, seniority, lead: {name, role, company, location, background}, lastMessage (null for cold_opener/follow_up), context, sentiment.
Make leads realistic — real firms, varied geographies.
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

function buildSimGuidance(currentCtx) {
  const prefs = store.getTrainingPreferences(workspace.getId());
  const scored = prefs.map(p => ({ ...p, _score: scoreTrainingRelevance(p, currentCtx) }));
  const topByType = (type, max) => scored
    .filter(p => p.type === type && p._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, max);

  const corrections = topByType('correction', 5).filter(p => p.original);
  const styleOnly = topByType('draft', 5);
  const thumbsUp = topByType('thumbs_up', 5);
  const thumbsDown = topByType('thumbs_down', 5);
  const annotations = scored
    .filter(p => p.type === 'annotation' && p._score > 0 && p.selectedText && p.feedback)
    .sort((a, b) => b._score - a._score)
    .slice(0, 5);

  const blocks = [];
  if (corrections.length) blocks.push(`\nCORRECTIONS (never write like the BAD, always like the GOOD):\n${corrections.map(p => `BAD: "${p.original}" → GOOD: "${p.chosen}"`).join('\n')}`);
  if (styleOnly.length) blocks.push(`\nSTYLE EXAMPLES (match tone and length):\n${styleOnly.map(p => `"${p.chosen}"`).join('\n')}`);
  if (thumbsUp.length) blocks.push(`\nGOOD DRAFTS (rated +):\n${thumbsUp.map(p => `"${p.chosen}"`).join('\n')}`);
  if (thumbsDown.length) blocks.push(`\nBAD DRAFTS (rated − — never write like these):\n${thumbsDown.map(p => `"${p.chosen}"`).join('\n')}`);
  if (annotations.length) blocks.push(`\nPHRASE-LEVEL FEEDBACK (from highlighted text):\n${annotations.map(p => `- "${p.selectedText}" — ${p.rating === 'good' ? 'GOOD' : 'BAD'}: ${p.feedback}`).join('\n')}`);
  return blocks.length ? blocks.join('\n') : null;
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
  const prompt = `You are simulating a realistic LinkedIn lead for training purposes. Play the role of this lead.

LEAD PROFILE:
Name: ${lead.name}
Role: ${lead.role}
Background: ${lead.background || ''}
${lead.location ? `Location: ${lead.location}` : ''}

CONVERSATION SO FAR:
${threadStr}

Rules:
- Sound like a real person on LinkedIn DM — short, casual, realistic
- React naturally. Sometimes curious, sometimes skeptical, sometimes brief
- Do NOT be overly enthusiastic
- If the conversation has reached a natural end (agreed, booked, or clearly rejected), set ended to true

Return ONLY valid JSON, no markdown:
{ "reply": "the lead's message", "ended": false }`;

  const raw = await claude.raw(prompt);
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { reply: raw, ended: false };
  } catch {
    return { reply: raw, ended: false };
  }
}

// POST /training/simulation/start
// body: { seniority?, stage? } — picks or generates a matching scenario
router.post('/simulation/start', async (req, res) => {
  const { seniority, stage } = req.body || {};
  try {
    initQueues();
    let scenario;
    if (seniority || stage) {
      const idx = queues.draft.findIndex(s =>
        (!seniority || s.seniority === seniority) && (!stage || s.stage === stage)
      );
      if (idx >= 0) {
        scenario = queues.draft.splice(idx, 1)[0];
      } else {
        const batch = await generateTargetedBatch(seniority, stage);
        if (batch.length > 0) {
          scenario = batch[0];
          if (batch.length > 1) enqueue('draft', batch.slice(1));
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

    res.json({
      lead: scenario.lead,
      seniority: scenario.seniority || seniority || 'unknown',
      stage: scenario.stage || stage || 'cold_opener',
      scenario,
    });
  } catch (err) {
    console.error('[Training] Simulation start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /training/simulation/step
// body: { lead, seniority, thread } — returns the next our-message + their-reply
router.post('/simulation/step', async (req, res) => {
  const { lead, seniority, thread } = req.body || {};
  if (!lead) return res.status(400).json({ error: 'lead required' });
  const safeThread = Array.isArray(thread) ? thread : [];

  try {
    const stage = nextSimStage(safeThread);
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
      creditsUsed: 0,
      creditsTotal: 20,
    };

    const routingDecision = {
      funnel_stage: stage,
      intent: stage === 'cold_opener' ? 'unknown — no prior reply' : 'engaged, exploring',
      next_objection: '',
      recommended_plan: null,
      is_follow_up: false,
      sentiment: '',
    };

    const currentCtx = {
      seniority: leadProfile.seniority,
      funnelStage: stage,
      sentiment: '',
      assetSegment: 'general',
      role: leadProfile.role,
      company: leadProfile.company,
      location: leadProfile.location,
      nextObjection: '',
      intent: routingDecision.intent,
      routingDecision: '',
    };

    const guidance = buildSimGuidance(currentCtx);
    const ourMessage = (await claude.draftMessage(safeThread, leadProfile, routingDecision, null, guidance)).trim();

    const threadWithOurs = [...safeThread, { sender: 'us', text: ourMessage }];
    const { reply, ended } = await simulateLeadReply(lead, threadWithOurs);

    res.json({
      ourMessage,
      theirReply: reply,
      ended: !!ended,
      stage,
      usedGuidance: !!guidance,
    });
  } catch (err) {
    console.error('[Training] Simulation step error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /training/preferences
router.get('/preferences', (req, res) => {
  const wsId = workspace.getId();
  const prefs = store.getTrainingPreferences(wsId);
  res.json({ workspace: wsId, preferences: prefs, total: prefs.length });
});

// DELETE /training/preferences
router.delete('/preferences', (req, res) => {
  store.clearTrainingPreferences();
  res.json({ success: true });
});

module.exports = router;
