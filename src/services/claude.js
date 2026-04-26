// src/services/claude.js
const Anthropic = require('@anthropic-ai/sdk');
const {
  buildSystemPrompt,
  CLASSIFY_AND_ROUTE_PROMPT,
  DRAFT_MESSAGE_PROMPT,
  CLASSIFY_REPLY_SENTIMENT_PROMPT
} = require('../prompts/routing');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SONNET      = process.env.ROUTE_MODEL || 'claude-sonnet-4-6';
const HAIKU       = 'claude-haiku-4-5-20251001';
const DRAFT_MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS  = 1024;

const LOG_CACHE = process.env.LOG_CACHE !== 'false';

async function callClaude(userPrompt, options = {}) {
  const {
    systemPrompt = buildSystemPrompt(),
    maxTokens   = MAX_TOKENS,
    retries     = 2,
    temperature = 0.3,
    model       = SONNET,
    cacheSystem = true,
  } = options;

  const systemBlocks = cacheSystem
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemBlocks,
        messages: [{ role: 'user', content: userPrompt }]
      });
      if (LOG_CACHE && response.usage) {
        const u = response.usage;
        if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
          console.log(`[Claude] ${model} cache: read=${u.cache_read_input_tokens || 0} create=${u.cache_creation_input_tokens || 0} input=${u.input_tokens || 0} output=${u.output_tokens || 0}`);
        }
      }
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

// Drafting — quality matters for the actual message the lead sees.
// Uses DRAFT_MODEL (default: claude-sonnet-4-6). Set DRAFT_MODEL=claude-opus-4-7 to upgrade —
// caching the system prompt makes Opus drafting cost-feasible on the hot path.
async function draftMessage(thread, leadProfile, routingDecision, asset = null, templateGuidance = null) {
  const prompt = DRAFT_MESSAGE_PROMPT(thread, leadProfile, routingDecision, asset, templateGuidance);
  const message = await callClaude(prompt, { temperature: 0.6, maxTokens: 512, model: DRAFT_MODEL });
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

// Haiku — training scenario generation is lower stakes.
// Uses the same workspace-driven system prompt as production so generated
// drafts reflect what the business actually sells, not generic guesses.
async function raw(prompt) {
  return callClaude(prompt, {
    systemPrompt: buildSystemPrompt(),
    temperature: 0.7,
    model: HAIKU
  });
}

module.exports = { classifyAndRoute, draftMessage, classifyInboundSentiment, raw };
