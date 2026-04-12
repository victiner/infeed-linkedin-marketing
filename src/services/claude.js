// src/services/claude.js
const Anthropic = require('@anthropic-ai/sdk');
const {
  SYSTEM_PROMPT,
  CLASSIFY_AND_ROUTE_PROMPT,
  DRAFT_MESSAGE_PROMPT,
  CLASSIFY_REPLY_SENTIMENT_PROMPT
} = require('../prompts/routing');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SONNET = 'claude-sonnet-4-20250514';
const HAIKU = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;

async function callClaude(userPrompt, options = {}) {
  const {
    systemPrompt = SYSTEM_PROMPT,
    maxTokens = MAX_TOKENS,
    retries = 2,
    temperature = 0.3,
    model = SONNET
  } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
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

function parseJSON(text) {
  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse Claude JSON response: ${text.substring(0, 200)}`);
  }
}

// Sonnet — needs nuance for routing decisions
async function classifyAndRoute(thread, leadProfile) {
  const prompt = CLASSIFY_AND_ROUTE_PROMPT(thread, leadProfile);
  const raw = await callClaude(prompt, { temperature: 0.1, model: SONNET });
  const decision = parseJSON(raw);
  const required = ['stage', 'sentiment', 'routing_decision', 'routing_reason'];
  for (const field of required) {
    if (!decision[field]) throw new Error(`Missing required field in routing decision: ${field}`);
  }
  return decision;
}

// Sonnet — quality matters for the actual message the lead sees
async function draftMessage(thread, leadProfile, routingDecision, asset = null, templateGuidance = null) {
  const prompt = DRAFT_MESSAGE_PROMPT(thread, leadProfile, routingDecision, asset, templateGuidance);
  const message = await callClaude(prompt, { temperature: 0.6, maxTokens: 512, model: SONNET });
  return message.trim();
}

// Haiku — simple classification, doesn't need Sonnet
async function classifyInboundSentiment(messageText) {
  const prompt = CLASSIFY_REPLY_SENTIMENT_PROMPT(messageText);
  const raw = await callClaude(prompt, {
    systemPrompt: 'You are a message classifier. Return only valid JSON.',
    temperature: 0.0,
    model: HAIKU
  });
  return parseJSON(raw);
}

// Haiku — training scenario generation is lower stakes
async function raw(prompt) {
  return callClaude(prompt, {
    systemPrompt: 'You generate LinkedIn DM responses. Be concise and human.',
    temperature: 0.7,
    model: HAIKU
  });
}

module.exports = { classifyAndRoute, draftMessage, classifyInboundSentiment, raw };
