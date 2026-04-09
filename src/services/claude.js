// src/services/claude.js
// Wrapper for all Claude API calls with retry logic and structured output parsing

const Anthropic = require('@anthropic-ai/sdk');
const {
  SYSTEM_PROMPT,
  CLASSIFY_AND_ROUTE_PROMPT,
  DRAFT_MESSAGE_PROMPT,
  CLASSIFY_REPLY_SENTIMENT_PROMPT
} = require('../prompts/routing');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1024;

// Generic call with retry
async function callClaude(userPrompt, options = {}) {
  const {
    systemPrompt = SYSTEM_PROMPT,
    maxTokens = MAX_TOKENS,
    retries = 2,
    temperature = 0.3
  } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });
      return response.content[0].text;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// Parse JSON from Claude response safely
function parseJSON(text) {
  try {
    // Strip markdown code fences if present
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    // Try to extract JSON object from text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse Claude JSON response: ${text.substring(0, 200)}`);
  }
}

// Classify lead stage and decide routing
async function classifyAndRoute(thread, leadProfile) {
  const prompt = CLASSIFY_AND_ROUTE_PROMPT(thread, leadProfile);
  const raw = await callClaude(prompt, { temperature: 0.1 });
  const decision = parseJSON(raw);

  // Validate required fields
  const required = ['stage', 'sentiment', 'routing_decision', 'routing_reason'];
  for (const field of required) {
    if (!decision[field]) {
      throw new Error(`Missing required field in routing decision: ${field}`);
    }
  }

  return decision;
}

// Draft a personalized reply message
async function draftMessage(thread, leadProfile, routingDecision, asset = null, templateGuidance = null) {
  const prompt = DRAFT_MESSAGE_PROMPT(thread, leadProfile, routingDecision, asset, templateGuidance);
  const message = await callClaude(prompt, {
    temperature: 0.6,
    maxTokens: 512
  });
  return message.trim();
}

// Quick sentiment classification of a single inbound message
async function classifyInboundSentiment(messageText) {
  const prompt = CLASSIFY_REPLY_SENTIMENT_PROMPT(messageText);
  const raw = await callClaude(prompt, {
    systemPrompt: 'You are a message classifier. Return only valid JSON.',
    temperature: 0.0
  });
  return parseJSON(raw);
}

module.exports = { classifyAndRoute, draftMessage, classifyInboundSentiment };
