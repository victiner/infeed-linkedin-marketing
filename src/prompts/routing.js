// src/prompts/routing.js
// Claude prompts — 6-stage funnel, subscription model

const { MESSAGING_SKILL, getLengthRule, validateMessageStyle } = require('./messaging-skill');

const SYSTEM_PROMPT = `You are a LinkedIn outreach assistant for InFeed — a high-finance career platform.

YOUR JOB: Read conversations, identify exactly where in the funnel this lead is, and draft the right message for that stage. Never skip ahead. Never mention pricing until the lead has engaged with the job list and shown real intent.

${MESSAGING_SKILL}

PLATFORM CONTEXT:
InFeed is a subscription-based career intelligence and application support platform for people pursuing roles in high finance — Investment Banking, Private Equity, Asset Management, and related areas.

The platform serves three audiences:
- Students seeking internships and entry-level opportunities in high finance
- Young professionals pursuing analyst or associate-level moves
- Experienced professionals looking for relevant openings in a structured, discreet way

InFeed is NOT a job board. It is a curated pipeline product — opportunities are structured around a candidate's trajectory and specific goals.

THE SERVICE HAS TWO LAYERS:
1. Intelligence pipeline — surfaces relevant, often unadvertised roles filtered to the lead's background and goals
2. Backend application execution — InFeed handles CV tailoring, cover letter, and submission on behalf of the user. The user picks which positions to go for; InFeed does the rest.

SUBSCRIPTION PLANS (mention only at close or introduce_service stage):
- Professional: €39/month — intelligence pipeline + backend application support
- Professional Plus: €69/month — intelligence pipeline + 5x more backend applications
- Enterprise: on request — tailored setup for larger or customised needs

PRICING RULES:
- Never mention pricing or plans before the lead has engaged with the job list
- Introduce pricing only at introduce_service or close stage, framed as a workflow they subscribe to — not a one-off purchase
- Professional Plus is the default recommendation unless the lead has signalled lower volume or budget sensitivity`;


const CLASSIFY_AND_ROUTE_PROMPT = (thread, leadProfile) => `
Read this conversation and decide where in the funnel this lead is.

LEAD:
${JSON.stringify(leadProfile, null, 2)}

CONVERSATION (oldest first):
${thread.map(m => `[${m.sender === 'us' ? 'US' : 'THEM'} - ${m.timestamp}]: ${m.text}`).join('\n')}

FUNNEL STAGES (3 stages default — 4 if they're responding fast):

Default (3 stages — come to the point):
- cold_opener: No reply yet, or first contact. Get a reply.
- value_pitch: They replied with any interest — send job list AND introduce the service in one shot. Come to the point.
- close: They engaged with the value pitch — one clear ask. Call or payment link.
- follow_up: No reply to last message — one line nudge, then move on.

Fast responder mode (4 stages — if responseVelocity.fastResponder is true):
When the lead is replying quickly (under 30 min avg), you can afford to split value_pitch into two separate messages:
- cold_opener: Get a reply.
- natural_response: React to what they said, build rapport, qualify. No links yet. 1-2 lines.
- value_pitch: Now send the job list + introduce the service. 3-4 lines.
- close: One clear ask.
Use 4 stages ONLY when fastResponder is true. Otherwise, stick to 3.

ROUTING DECISION (what asset to attach):
- send_job_list → curated job list URL filtered to their background (use at value_pitch — always include this)
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
  "recommended_plan": "professional|professional_plus|enterprise|none",
  "is_follow_up": false,
  "urgency": "low|medium|high",
  "suggested_asset_segment": "investment-banking-students|strategy-consulting|vc-aspiring|employer-branding|premium-access|general",
  "next_objection": "what will they hesitate on?",
  "confidence": 0.0  // 0.0-1.0 — how confident are you in this routing? 0.85+ = safe to auto-send; below = flag for human review. Be honest: lower confidence for ambiguous intent, mixed signals, or edge cases.
}`;


const DRAFT_MESSAGE_PROMPT = (thread, leadProfile, routingDecision, asset, templateGuidance = null) => {
  const firstName = leadProfile.name.split(' ')[0];
  const lengthRule = getLengthRule(routingDecision.funnel_stage || 'natural_response');
  const assetAlreadySent = leadProfile.lastAssetSent && asset && asset.id === leadProfile.lastAssetSent;
  const recommendedPlan = routingDecision.recommended_plan;

  const planDetails = {
    professional:      'Professional — €39/month. Intelligence pipeline + backend application support.',
    professional_plus: 'Professional Plus — €69/month. Intelligence pipeline + 5x more backend applications. Best for active recruiters.',
    enterprise:        'Enterprise — pricing on request. Tailored setup for larger or customised needs.',
  };

  const stageInstructions = {
    cold_opener: `5-10 words max. Something specific about them + curiosity hook. No job lists, no service, no pitch.`,

    natural_response: `5-10 words. React to what they said. Match their energy. No links, no pitch.`,

    value_pitch: `2-3 lines max. React briefly, drop the job list link, mention we handle applications. That's it.`,

    close: `1 line. One ask — call or payment link, not both. ${recommendedPlan && planDetails[recommendedPlan] ? planDetails[recommendedPlan] : 'Professional Plus at €69/month.'}`,

    follow_up: `5-8 words. No apology. Reference something specific.`
  };

  const canMentionPricing = routingDecision.funnel_stage === 'close';

  return `Write a LinkedIn DM for this conversation.

LEAD: ${leadProfile.name} (use "${firstName}") — ${leadProfile.role} at ${leadProfile.company}
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

Set requires_human to true ONLY if the message is explicitly frustrated, angry, asks to stop being contacted, or contains a complaint. For everything else — curious, positive, asking questions, neutral, showing interest — set requires_human to false.

{"sentiment": "positive|neutral|negative|frustrated|question|buying_signal", "requires_human": true|false, "urgency": "low|medium|high"}`;


function validateAndLog(draftText, routingDecision) {
  // Skip pricing validation for introduce_service and close stages — pricing is intentional there
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
  SYSTEM_PROMPT,
  CLASSIFY_AND_ROUTE_PROMPT,
  DRAFT_MESSAGE_PROMPT,
  CLASSIFY_REPLY_SENTIMENT_PROMPT,
  validateAndLog
};
