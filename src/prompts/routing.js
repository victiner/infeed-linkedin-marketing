// src/prompts/routing.js
// Claude prompts — workspace-driven, 3-stage funnel

const { buildMessagingSkill, getLengthRule, validateMessageStyle } = require('./messaging-skill');
const workspace = require('../services/workspace');

// Build system prompt dynamically from workspace config
function buildSystemPrompt() {
  const ws = workspace.get();
  const biz = ws.company;
  const MESSAGING_SKILL = buildMessagingSkill();

  const plansStr = ws.plans.map(p => `- ${p.name}: ${p.price} — ${p.includes}`).join('\n');
  const audiencesStr = ws.audiences.map(a => `- ${a.segment}: ${a.description}`).join('\n');
  const servicesStr = ws.services.map((s, i) => `${i + 1}. ${s.name} — ${s.description}`).join('\n');
  const pricing = ws.pricing_rules;

  return `You are a LinkedIn outreach assistant for ${biz.name} — ${biz.tagline}.

YOUR JOB: Read conversations, identify exactly where in the funnel this lead is, and draft the right message for that stage. Never skip ahead. Never mention pricing until the lead has engaged with the value offering and shown real intent.

${MESSAGING_SKILL}

PLATFORM CONTEXT:
${biz.what_it_is}. ${biz.what_it_is_not || ''}
Industries: ${ws.industries.join(', ')}.

Audiences:
${audiencesStr}

Service layers:
${servicesStr}

SUBSCRIPTION PLANS (mention only at close stage):
${plansStr}

PRICING RULES:
- Never mention pricing before ${pricing.never_mention_before}
- Introduce at ${pricing.introduce_at}, framed as: ${pricing.framing}
- Default recommendation: ${pricing.default_recommendation}`;
}


const CLASSIFY_AND_ROUTE_PROMPT = (thread, leadProfile) => {
  const ws = workspace.get();
  const segments = Object.keys(ws.industry_keywords).join('|');

  return `
Read this conversation and decide where in the funnel this lead is.

LEAD:
${JSON.stringify(leadProfile, null, 2)}

CONVERSATION (oldest first):
${thread.map(m => `[${m.sender === 'us' ? 'US' : 'THEM'} - ${m.timestamp}]: ${m.text}`).join('\n')}

FUNNEL STAGES (3 stages default — 4 if they're responding fast):

Default (3 stages — come to the point):
- cold_opener: No reply yet, or first contact. Get a reply.
- value_pitch: They replied with any interest — deliver value AND introduce the service in one shot. Come to the point.
- close: They engaged with the value pitch — one clear ask. Call or payment link.
- follow_up: No reply to last message — one line nudge, then move on.

Fast responder mode (4 stages — if responseVelocity.fastResponder is true):
When the lead is replying quickly (under 30 min avg), you can afford to split value_pitch into two separate messages:
- cold_opener: Get a reply.
- natural_response: React to what they said, build rapport, qualify. No links yet. 1-2 lines.
- value_pitch: Now deliver value + introduce the service. 3-4 lines.
- close: One clear ask.
Use 4 stages ONLY when fastResponder is true. Otherwise, stick to 3.

ROUTING DECISION (what asset to attach):
- send_job_list → curated value asset filtered to their background (use at value_pitch — always include this)
- send_landing_page → platform overview if they need more context
- book_call → calendar link (for leads ready to talk)
- send_payment_link → subscription checkout link (only at close stage)
- send_onboarding_link → onboarding URL for leads who have subscribed
- human_takeover → flag for human — frustrated, complex objection, enterprise inquiry
- no_action → respond naturally, no asset needed

Return ONLY valid JSON, no markdown:
{
  "funnel_stage": "cold_opener|natural_response|value_pitch|close|follow_up",
  "stage": "cold|warm|hot|close|nurture",
  "sentiment": "positive|neutral|negative|frustrated|curious",
  "intent": "one sentence — what does this lead actually want?",
  "routing_decision": "send_job_list|send_landing_page|book_call|send_payment_link|send_onboarding_link|human_takeover|no_action",
  "routing_reason": "one sentence — why this stage and routing",
  "recommended_plan": "${ws.plans.map(p => p.name.toLowerCase().replace(/\\s+/g, '_')).join('|')}|none",
  "is_follow_up": false,
  "urgency": "low|medium|high",
  "suggested_asset_segment": "${segments}",
  "next_objection": "what will they hesitate on?",
  "confidence": 0.0
}`;
};


const DRAFT_MESSAGE_PROMPT = (thread, leadProfile, routingDecision, asset, templateGuidance = null) => {
  const planDetails = workspace.getPlanDetails();
  const firstName = leadProfile.name.split(' ')[0];
  const lengthRule = getLengthRule(routingDecision.funnel_stage || 'natural_response');
  const assetAlreadySent = leadProfile.lastAssetSent && asset && asset.id === leadProfile.lastAssetSent;
  const recommendedPlan = routingDecision.recommended_plan;

  const stageInstructions = {
    cold_opener: `5-10 words max. Something specific about them + curiosity hook. No value assets, no service, no pitch.`,

    natural_response: `5-10 words. React to what they said. Match their energy. No links, no pitch.`,

    value_pitch: `2-3 lines max. React briefly, drop the value link, mention what we do. That's it.`,

    close: `1 line. One ask — call or payment link, not both. ${recommendedPlan && planDetails[recommendedPlan] ? planDetails[recommendedPlan] : ''}`,

    follow_up: `5-8 words. No apology. Reference something specific.`
  };

  const canMentionPricing = routingDecision.funnel_stage === 'close';

  const toneInstructions = {
    student_casual: 'You\'re peers — same age, same world. Casual, direct, short. Reference their background or goals. Fragments fine.',
    professional_warm: 'Professional but warm. They have experience — still relaxed but show you know your stuff. Reference their current role or company.',
    respectful_concise: 'Respectful and concise. They\'re senior — don\'t waste their time. No small talk. One clear point, lead with value.',
  };

  return `Write a LinkedIn DM for this conversation.

LEAD: ${leadProfile.name} (use "${firstName}") — ${leadProfile.role} at ${leadProfile.company}
${leadProfile.location ? `LOCATION: ${leadProfile.location}` : ''}
${leadProfile.summary ? `BIO: ${leadProfile.summary}` : ''}
SENIORITY: ${leadProfile.seniority || 'unknown'}
TONE: ${toneInstructions[leadProfile.seniorityTone] || toneInstructions.professional_warm}
FUNNEL STAGE: ${routingDecision.funnel_stage}
WHAT THEY WANT: ${routingDecision.intent}
THEIR LIKELY HESITATION: ${routingDecision.next_objection || 'none identified'}
RECOMMENDED PLAN: ${recommendedPlan || 'none yet'}
LAST ASSET SENT: ${leadProfile.lastAssetSent || 'none'}

CONVERSATION:
${thread.map(m => `[${m.sender === 'us' ? 'US' : 'THEM'}]: ${m.text}`).join('\n')}

STAGE INSTRUCTION:
${stageInstructions[routingDecision.funnel_stage] || stageInstructions.value_pitch}

${asset && !assetAlreadySent ? `ASSET TO INCLUDE:
${asset.name}: ${asset.url}
(${asset.description})` : assetAlreadySent ? 'NOTE: This asset was already sent — reference it naturally, do not re-send.' : ''}

LENGTH: ${lengthRule.maxLines} lines max
${routingDecision.is_follow_up ? 'FOLLOW-UP: 1 line only. No apology.' : ''}
${!canMentionPricing ? 'DO NOT mention pricing, subscription cost, or plan names.' : ''}
${templateGuidance ? `\nCAMPAIGN GUIDANCE (use as direction for tone and content, but write naturally):\n${templateGuidance}` : ''}

Return ONLY the message text.`;
};


const CLASSIFY_REPLY_SENTIMENT_PROMPT = (message) => `
Classify this LinkedIn message. Return ONLY JSON, no preamble.

Message: "${message}"

Set requires_human to true ONLY if the person explicitly asks to stop being contacted ("stop messaging me", "unsubscribe", "remove me"). Price objections, frustration, skepticism, complaints, and tough questions should all be set to false — the AI handles these.

{"sentiment": "positive|neutral|negative|frustrated|question|buying_signal", "requires_human": true|false, "urgency": "low|medium|high"}`;


function validateAndLog(draftText, routingDecision) {
  const skipPricingCheck = routingDecision.funnel_stage === 'close';

  const { valid, warnings: allWarnings } = validateMessageStyle(draftText);
  const warnings = skipPricingCheck
    ? allWarnings.filter(w => !w.includes('Pricing mentioned'))
    : allWarnings;

  if (warnings.length > 0) {
    console.warn(`[Prompts] Draft warnings (${routingDecision.funnel_stage}):`);
    warnings.forEach(w => console.warn(`  - ${w}`));
  }
  return { valid: warnings.length === 0, warnings };
}


module.exports = {
  buildSystemPrompt,
  CLASSIFY_AND_ROUTE_PROMPT,
  DRAFT_MESSAGE_PROMPT,
  CLASSIFY_REPLY_SENTIMENT_PROMPT,
  validateAndLog
};
