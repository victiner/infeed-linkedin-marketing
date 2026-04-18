// src/routes/training.js
const express = require('express');
const router = express.Router();
const store = require('../services/store');
const claude = require('../services/claude');
const workspace = require('../services/workspace');

// How many ratings per scenario is "enough" — above this threshold, we stop
// showing the scenario in the training panel (it's saturated).
const SATURATION_THRESHOLD = 5;

// Stable key for a scenario — must match what the dashboard generates when rating.
function scenarioKey(scenario) {
  const seniority = scenario?.seniority || 'unknown';
  const stage = scenario?.stage || scenario?.funnelStage || 'unknown';
  const leadName = (scenario?.lead?.name || '').replace(/\s+/g, '_');
  return `${seniority}_${stage}_${leadName}`;
}

// Load draft scenarios from workspace config, fall back to generic defaults
function getDraftScenarios() {
  const ws = workspace.get();
  if (ws.training_scenarios && ws.training_scenarios.length > 0) {
    return ws.training_scenarios;
  }
  // Generic fallback scenarios that work for any business
  return [
    { stage: 'cold_opener', lead: { name: 'Test Lead', role: 'Professional', company: 'Company', background: 'Experienced' }, lastMessage: null, context: 'First outreach — no prior conversation' },
    { stage: 'value_pitch', lead: { name: 'Test Lead', role: 'Professional', company: 'Company', background: 'Interested' }, lastMessage: 'Yeah I\'m interested', context: 'Replied positively to cold opener' },
    { stage: 'close', lead: { name: 'Test Lead', role: 'Professional', company: 'Company', background: 'Ready' }, lastMessage: 'How much does it cost?', context: 'Asked about pricing' },
    { stage: 'objection', lead: { name: 'Test Lead', role: 'Professional', company: 'Company', background: 'Skeptical' }, lastMessage: 'I don\'t want to pay that much', context: 'Price objection' },
    { stage: 'follow_up', lead: { name: 'Test Lead', role: 'Professional', company: 'Company', background: 'Silent' }, lastMessage: null, context: 'No reply to value pitch sent 3 days ago' },
  ];
}

// Pick a scenario that's under the saturation threshold.
// Uses the write-time index in store.js — O(1) count lookup per scenario,
// no iteration over training preferences. Stays efficient as the data grows.
function pickUnsaturatedScenario() {
  const scenarios = getDraftScenarios();
  if (scenarios.length === 0) return null;

  const wsId = workspace.getId();
  const withCounts = scenarios.map(s => ({
    scenario: s,
    count: store.getScenarioCount(wsId, s),
  }));

  const unsaturated = withCounts.filter(x => x.count < SATURATION_THRESHOLD);
  if (unsaturated.length > 0) {
    // Prefer scenarios with the lowest count (most neglected)
    const minCount = Math.min(...unsaturated.map(x => x.count));
    const leastTrained = unsaturated.filter(x => x.count === minCount);
    return leastTrained[Math.floor(Math.random() * leastTrained.length)].scenario;
  }

  // Everything saturated — return the least-trained one
  withCounts.sort((a, b) => a.count - b.count);
  return withCounts[0].scenario;
}

// Sentiment scenarios are industry-agnostic — same across all workspaces
const SENTIMENT_SCENARIOS = [
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

// Routing scenarios are also generic
const ROUTING_SCENARIOS = [
  { lead: { name: 'Test Lead', role: 'Professional', stage: 'cold' }, messages: [{ sender: 'us', text: 'Still on your radar?' }, { sender: 'them', text: 'Yeah actually, what do you have?' }], expectedRoute: 'send_job_list' },
  { lead: { name: 'Test Lead', role: 'Professional', stage: 'warm' }, messages: [{ sender: 'us', text: 'Here\'s what I found for your background: link' }, { sender: 'them', text: 'These look great, how do I sign up?' }], expectedRoute: 'send_payment_link' },
  { lead: { name: 'Test Lead', role: 'Professional', stage: 'cold' }, messages: [{ sender: 'us', text: 'Thinking about your next move?' }, { sender: 'them', text: 'Please stop contacting me' }], expectedRoute: 'human_takeover' },
  { lead: { name: 'Test Lead', role: 'Professional', stage: 'warm' }, messages: [{ sender: 'us', text: 'Pulled some options for you: link' }, { sender: 'them', text: 'Can we jump on a quick call?' }], expectedRoute: 'book_call' },
];

function getPreferenceExamples(type) {
  return store.getTrainingPreferences(workspace.getId())
    .filter(p => !type || p.type === type)
    .slice(-20)
    .map(p => `Chosen: "${p.chosen}"`)
    .join('\n');
}

// GET /training/scenario?type=draft|sentiment|routing
router.get('/scenario', async (req, res) => {
  const type = req.query.type || 'draft';
  try {
    if (type === 'sentiment') {
      const scenario = SENTIMENT_SCENARIOS[Math.floor(Math.random() * SENTIMENT_SCENARIOS.length)];
      const options = ['positive', 'neutral', 'negative', 'frustrated', 'question', 'buying_signal'];
      return res.json({ type: 'sentiment', scenario, options });
    }

    if (type === 'routing') {
      const scenario = ROUTING_SCENARIOS[Math.floor(Math.random() * ROUTING_SCENARIOS.length)];
      const options = ['send_job_list', 'send_landing_page', 'book_call', 'send_payment_link', 'send_onboarding_link', 'human_takeover', 'no_action'];
      return res.json({ type: 'routing', scenario, options });
    }

    // Draft scenario — pick the least-trained one first
    const scenario = pickUnsaturatedScenario();
    if (!scenario) {
      return res.status(404).json({ error: 'No training scenarios available for this workspace' });
    }
    const styleExamples = getPreferenceExamples('draft');

    const prompt = `Generate 3 different LinkedIn DM response options that WE would send to this lead. We are the outreach side (the platform described in your system prompt) — the lead is the recipient. Never invert this: do not pitch the lead's own work back to them, do not offer them deal flow, deal sourcing, capital, or anything they would supply professionally. We are reaching out about what our platform offers them.

Each option should be distinctly different but all should sound human, casual, and short (5-15 words for simple replies, max 2-3 lines for pitches).

SCENARIO:
Lead (recipient): ${scenario.lead.name} — ${scenario.lead.role}
Background: ${scenario.lead.background}
Stage: ${scenario.stage}
Context: ${scenario.context}
${scenario.lastMessage ? `Their last message to us: "${scenario.lastMessage}"` : 'No prior message — this is our first outreach to them.'}
${styleExamples ? `\nMATCH THIS STYLE:\n${styleExamples}\n` : ''}

Return ONLY a JSON array of 3 strings. No markdown.
["option 1", "option 2", "option 3"]`;

    const response = await claude.raw(prompt);
    let options;
    try {
      const match = response.match(/\[[\s\S]*\]/);
      options = match ? JSON.parse(match[0]) : [response];
    } catch { options = [response]; }

    res.json({ type: 'draft', scenario, options });
  } catch (err) {
    console.error('[Training] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /training/preference
router.post('/preference', (req, res) => {
  const { type, scenario, chosen, original, optionIndex, isCustom } = req.body;
  if (!chosen) return res.status(400).json({ error: 'chosen required' });

  const pref = { type: type || 'draft', scenario, chosen, optionIndex, isCustom, timestamp: new Date().toISOString() };
  if (original) pref.original = original;
  store.addTrainingPreference(pref);
  const total = store.getTrainingPreferences().length;
  console.log(`[Training] ${type || 'draft'} preference recorded (${total} total)${original ? ' [correction]' : ''}`);
  res.json({ success: true, totalPreferences: total });
});

// POST /training/rate — rate an auto-sent or manual message
router.post('/rate', (req, res) => {
  const { conversationId, leadName, messageText, rating, category, feedback, wasAutoSent } = req.body;
  if (!rating) return res.status(400).json({ error: 'rating required' });

  store.addMessageRating({
    conversationId, leadName, messageText,
    rating, category, feedback, wasAutoSent,
    timestamp: new Date().toISOString()
  });
  console.log(`[Training] Message rated: ${rating}/5 (${category || 'general'})`);
  res.json({ success: true });
});

// GET /training/coverage — shows how saturated each scenario is.
// Uses the O(1) write-time index in store.js, not a full scan of preferences.
router.get('/coverage', (req, res) => {
  const scenarios = getDraftScenarios();
  const wsId = workspace.getId();

  const coverage = scenarios.map(s => {
    const count = store.getScenarioCount(wsId, s);
    return {
      key: scenarioKey(s),
      seniority: s.seniority || 'unknown',
      stage: s.stage || 'unknown',
      lead: s.lead?.name || '',
      context: s.context || '',
      count,
      saturated: count >= SATURATION_THRESHOLD,
    };
  });

  const saturated = coverage.filter(c => c.saturated).length;
  const total = coverage.length;

  res.json({
    threshold: SATURATION_THRESHOLD,
    total,
    saturated,
    remaining: total - saturated,
    percentComplete: total > 0 ? Math.round((saturated / total) * 100) : 0,
    coverage: coverage.sort((a, b) => a.count - b.count),
  });
});

// GET /training/stats
router.get('/stats', (req, res) => {
  const wsId = workspace.getId();
  const prefs = store.getTrainingPreferences(wsId);
  const ratings = store.getMessageRatings(wsId);
  const byType = { draft: 0, sentiment: 0, routing: 0 };
  prefs.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1; });
  const avgRating = ratings.length ? (ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(1) : null;
  res.json({ workspace: wsId, totalPreferences: prefs.length, byType, totalRatings: ratings.length, averageRating: avgRating });
});

// GET /training/export — CSV download of all training data + ratings
router.get('/export', (req, res) => {
  const wsId = workspace.getId();
  const prefs = store.getTrainingPreferences(wsId);
  const ratings = store.getMessageRatings(wsId);

  let csv = 'Section,Type,Timestamp,Scenario/Lead,Chosen/Message,Rating,Category,Feedback,IsCustom,WorkspaceId\n';

  prefs.forEach(p => {
    const scenarioStr = typeof p.scenario === 'object'
      ? `${p.scenario?.lead?.name || ''} (${p.scenario?.stage || p.type})`
      : String(p.scenario || '');
    csv += `Training,${p.type},${p.timestamp},"${scenarioStr.replace(/"/g, '""')}","${String(p.chosen).replace(/"/g, '""')}",,,${p.isCustom ? 'Yes' : 'No'},${wsId}\n`;
  });

  ratings.forEach(r => {
    csv += `Rating,,${r.timestamp},"${(r.leadName || '').replace(/"/g, '""')}","${String(r.messageText || '').replace(/"/g, '""')}",${r.rating},${r.category || ''},"${(r.feedback || '').replace(/"/g, '""')}",${wsId}\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=training-export-${wsId}-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(csv);
});

// Infer the funnel stage from how many messages we've sent in a conversation
function inferStage(ourMessageCount) {
  if (ourMessageCount <= 1) return 'cold_opener';
  if (ourMessageCount === 2) return 'value_pitch';
  return 'close';
}

// Build normalized scenario metadata for a conversation turn so it feeds
// into the production smart-matching system (scoreTrainingRelevance).
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

// POST /training/conversation/start — coverage-driven conversation flow
router.post('/conversation/start', async (req, res) => {
  try {
    const scenario = pickUnsaturatedScenario();
    if (!scenario) return res.status(404).json({ error: 'No scenarios configured' });

    const lead = { ...scenario.lead, location: scenario.lead?.location };
    const seniority = scenario.seniority || 'unknown';
    const styleExamples = getPreferenceExamples('draft');

    const prompt = `Generate 3 different LinkedIn DM cold opener options that WE would send to this lead as a first message. We are the outreach side (the platform described in your system prompt) — the lead is the recipient.

Each should be distinctly different but all should sound human, casual, and short (max 2-3 lines).

LEAD (recipient): ${lead.name} — ${lead.role}
Background: ${lead.background}
${lead.location ? `Location: ${lead.location}` : ''}
${styleExamples ? `\nMATCH THIS STYLE:\n${styleExamples}\n` : ''}

Return ONLY a JSON array of 3 strings. No markdown.
["option 1", "option 2", "option 3"]`;

    const response = await claude.raw(prompt);
    let options;
    try {
      const match = response.match(/\[[\s\S]*\]/);
      options = match ? JSON.parse(match[0]) : [response];
    } catch { options = [response]; }

    res.json({ lead, seniority, thread: [], options, ended: false, stage: 'cold_opener' });
  } catch (err) {
    console.error('[Training] Conversation start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /training/conversation/reply — save per-turn preference, simulate lead reply, generate next options
router.post('/conversation/reply', async (req, res) => {
  const { lead, seniority, thread, chosenReply } = req.body;
  if (!lead || !chosenReply) return res.status(400).json({ error: 'lead and chosenReply required' });

  const updatedThread = [...(thread || []), { sender: 'us', text: chosenReply }];
  const ourCount = updatedThread.filter(m => m.sender === 'us').length;
  const currentStage = inferStage(ourCount);

  // Save this turn as an individual preference with full metadata
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
    const threadStr = updatedThread.map(m =>
      `[${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`
    ).join('\n');

    const replyPrompt = `You are simulating a realistic LinkedIn lead for training purposes. You are playing the role of the LEAD described below. Read the conversation and write the lead's next reply.

LEAD PROFILE:
Name: ${lead.name}
Role: ${lead.role}
Background: ${lead.background}
${lead.location ? `Location: ${lead.location}` : ''}

CONVERSATION SO FAR:
${threadStr}

Rules for the simulated reply:
- Sound like a real person on LinkedIn DM — short, casual, realistic
- React naturally to what was said. Sometimes curious, sometimes skeptical, sometimes brief
- Vary response length: one-word replies are fine, questions are fine, longer replies are fine
- Do NOT be overly enthusiastic or accommodating — real leads are often neutral or mildly interested
- If the conversation has reached a natural end (they agreed to sign up, booked a call, or clearly rejected), reply with the JSON below instead

Return ONLY valid JSON, no markdown:
{ "reply": "the lead's message", "ended": false }

If the conversation is naturally over:
{ "reply": "final message if any", "ended": true }`;

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
    const optionsPrompt = `Generate 3 different LinkedIn DM response options that WE would send next in this conversation. We are the outreach side (the platform described in your system prompt) — the lead is the recipient.

Each should be distinctly different but all should sound human, casual, and short.

LEAD: ${lead.name} — ${lead.role}
Background: ${lead.background}

CONVERSATION SO FAR:
${updatedThread.map(m => `[${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`).join('\n')}
${styleExamples ? `\nMATCH THIS STYLE:\n${styleExamples}\n` : ''}

Return ONLY a JSON array of 3 strings. No markdown.
["option 1", "option 2", "option 3"]`;

    const optionsRaw = await claude.raw(optionsPrompt);
    let options;
    try {
      const match = optionsRaw.match(/\[[\s\S]*\]/);
      options = match ? JSON.parse(match[0]) : [optionsRaw];
    } catch { options = [optionsRaw]; }

    const nextStage = inferStage(ourCount + 1);
    res.json({ lead, seniority, thread: updatedThread, options, ended: false, stage: nextStage });
  } catch (err) {
    console.error('[Training] Conversation reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /training/filters — returns available seniority levels, stages, and avatars for targeted training
router.get('/filters', (req, res) => {
  const scenarios = getDraftScenarios();
  const ws = workspace.get();

  const seniorities = [...new Set(scenarios.map(s => s.seniority).filter(Boolean))];
  const stages = [...new Set(scenarios.map(s => s.stage).filter(Boolean))];
  const avatars = (ws.avatars || []).map(a => ({ id: a.id, name: a.name, seniority: a.seniority }));

  res.json({ seniorities, stages, avatars });
});

// GET /training/targeted?seniority=analyst&stage=value_pitch — filtered scenario generation
router.get('/targeted', async (req, res) => {
  const { seniority, stage } = req.query;
  if (!seniority && !stage) return res.status(400).json({ error: 'At least one of seniority or stage required' });

  try {
    const scenarios = getDraftScenarios();
    let filtered = scenarios;
    if (seniority) filtered = filtered.filter(s => s.seniority === seniority);
    if (stage) filtered = filtered.filter(s => s.stage === stage);

    if (filtered.length === 0) {
      return res.status(404).json({ error: `No scenarios match seniority=${seniority || 'any'} stage=${stage || 'any'}` });
    }

    // Pick least-trained among filtered
    const wsId = workspace.getId();
    const withCounts = filtered.map(s => ({ scenario: s, count: store.getScenarioCount(wsId, s) }));
    withCounts.sort((a, b) => a.count - b.count);
    const scenario = withCounts[0].scenario;

    const styleExamples = getPreferenceExamples('draft');
    const prompt = `Generate 3 different LinkedIn DM response options that WE would send to this lead. We are the outreach side (the platform described in your system prompt) — the lead is the recipient. Never invert this: do not pitch the lead's own work back to them, do not offer them deal flow, deal sourcing, capital, or anything they would supply professionally.

Each option should be distinctly different but all should sound human, casual, and short (5-15 words for simple replies, max 2-3 lines for pitches).

SCENARIO:
Lead (recipient): ${scenario.lead.name} — ${scenario.lead.role}
Background: ${scenario.lead.background}
Stage: ${scenario.stage}
Context: ${scenario.context}
${scenario.lastMessage ? `Their last message to us: "${scenario.lastMessage}"` : 'No prior message — this is our first outreach to them.'}
${styleExamples ? `\nMATCH THIS STYLE:\n${styleExamples}\n` : ''}

Return ONLY a JSON array of 3 strings. No markdown.
["option 1", "option 2", "option 3"]`;

    const response = await claude.raw(prompt);
    let options;
    try {
      const match = response.match(/\[[\s\S]*\]/);
      options = match ? JSON.parse(match[0]) : [response];
    } catch { options = [response]; }

    res.json({ type: 'targeted', scenario, options });
  } catch (err) {
    console.error('[Training] Targeted error:', err.message);
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
