// src/routes/training.js
const express = require('express');
const router = express.Router();
const store = require('../services/store');
const claude = require('../services/claude');
const workspace = require('../services/workspace');

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

    // Draft scenario
    const draftScenarios = getDraftScenarios();
    const scenario = draftScenarios[Math.floor(Math.random() * draftScenarios.length)];
    const styleExamples = getPreferenceExamples('draft');

    const prompt = `Generate 3 different LinkedIn DM response options for this scenario. Each should be distinctly different but all should sound human, casual, and short (5-15 words for simple replies, max 2-3 lines for pitches).

SCENARIO:
Lead: ${scenario.lead.name} — ${scenario.lead.role}
Background: ${scenario.lead.background}
Stage: ${scenario.stage}
Context: ${scenario.context}
${scenario.lastMessage ? `Their message: "${scenario.lastMessage}"` : 'No prior message — first outreach.'}
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
