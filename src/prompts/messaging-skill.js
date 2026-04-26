// src/prompts/messaging-skill.js
// Messaging skill — workspace-driven LinkedIn outreach sequence
// 3-stage funnel: opener → value → close

const workspace = require('../services/workspace');

// ============================================================
// THE FUNNEL (3 stages — move fast, be direct)
// ============================================================
//
// STAGE 1: COLD OPENER
//   Get a reply. 1-2 lines. No links, no pitch.
//
// STAGE 2: VALUE + PITCH
//   Respond naturally, deliver value, AND introduce the service.
//   All in one message. Come to the point.
//
// STAGE 3: CLOSE
//   One clear ask. Call or payment link. Done.
//
// ============================================================

function buildVoiceDnaBlock(voiceDna) {
  if (!voiceDna || typeof voiceDna !== 'object') return '';
  const lines = [];
  if (Array.isArray(voiceDna.rule_summary) && voiceDna.rule_summary.length) {
    lines.push('Top rules (these override everything else below if there is a conflict):');
    voiceDna.rule_summary.forEach(r => lines.push(`- ${r}`));
  }
  if (voiceDna.capitalization) lines.push(`Capitalization: ${voiceDna.capitalization}`);
  if (voiceDna.punctuation)    lines.push(`Punctuation: ${voiceDna.punctuation}`);
  if (voiceDna.contractions)   lines.push(`Contractions: ${voiceDna.contractions}`);
  if (voiceDna.rhythm)         lines.push(`Rhythm: ${voiceDna.rhythm}`);
  if (Array.isArray(voiceDna.vocabulary_use) && voiceDna.vocabulary_use.length) {
    lines.push(`Vocabulary the user actually uses: ${voiceDna.vocabulary_use.map(p => `"${p}"`).join(', ')}`);
  }
  if (Array.isArray(voiceDna.vocabulary_avoid) && voiceDna.vocabulary_avoid.length) {
    lines.push(`Vocabulary the user never uses: ${voiceDna.vocabulary_avoid.map(p => `"${p}"`).join(', ')}`);
  }
  if (Array.isArray(voiceDna.voice_quirks) && voiceDna.voice_quirks.length) {
    lines.push('Signature moves:');
    voiceDna.voice_quirks.forEach(q => lines.push(`- ${q}`));
  }
  if (Array.isArray(voiceDna.openers) && voiceDna.openers.length) {
    lines.push('Cold-open patterns:');
    voiceDna.openers.forEach(o => lines.push(`- ${o}`));
  }
  if (Array.isArray(voiceDna.closers) && voiceDna.closers.length) {
    lines.push('Closer patterns:');
    voiceDna.closers.forEach(c => lines.push(`- ${c}`));
  }
  if (voiceDna.stage_specific && typeof voiceDna.stage_specific === 'object') {
    const ss = voiceDna.stage_specific;
    const stagePairs = Object.entries(ss).filter(([_, v]) => v && typeof v === 'string');
    if (stagePairs.length) {
      lines.push('Stage-specific rules:');
      stagePairs.forEach(([k, v]) => lines.push(`- ${k}: ${v}`));
    }
  }
  if (!lines.length) return '';
  return `\n=== YOUR VOICE DNA (learned from your edits — apply these BEFORE the generic rules below) ===\n${lines.join('\n')}\n`;
}

function buildMessagingSkill() {
  const msg = workspace.getMessaging();
  const company = workspace.getCompany();

  // Voice DNA: prefer the live (Airtable-backed) snapshot from the service; fall back to
  // anything pasted into workspace.json. Service may not be loaded in CLI/test contexts.
  let liveVoiceDna = null;
  try {
    const voiceDna = require('../services/voice-dna');
    liveVoiceDna = voiceDna.getCurrent(workspace.getId());
  } catch {}
  const effectiveVoiceDna = liveVoiceDna || msg.voice_dna || null;

  const openerExamples = (msg.opener_examples || []).map(e => `"${e}"`).join('\n');
  const valueExamples = (msg.value_examples || []).map(e => `"${e}"`).join('\n');
  const closeExamples = (msg.close_examples || []).map(e => `"${e}"`).join('\n');
  const forbidden = (msg.forbidden_phrases || []).map(p => `- "${p}"`).join('\n');
  const rules = (msg.rules || []).map(r => `- ${r}`).join('\n');
  const voiceDnaBlock = buildVoiceDnaBlock(effectiveVoiceDna);

  return `
=== MESSAGING SKILL: ${company.name} LinkedIn Outreach ===

CORE RULE: 3 stages max. Get to the point fast.
Stage 1 earns a reply. Stage 2 delivers value and pitches the service. Stage 3 closes.
Don't stretch this out — if they're interested, move.

TONE: ${msg.voice || 'Conversational and direct. This is a DM, not an email.'}
Register: ${msg.register || 'DM-style, not email-style'}
${voiceDnaBlock}

CONVERSATIONAL RULES:
${rules}
- Keep it SHORT. Most replies should be 5-10 words. Only go longer (2-3 lines) when delivering value or explaining the service.
- React to what they said before making your point.
- Fragments are fine. Incomplete sentences are fine. This is how people text.
- Mirror their register. If they send 3 words, you send 3-5 words back.
- Never sound like a template. If you could swap any name in and it still reads the same, rewrite it.
- No filler. No fluff. Say the thing, then stop.

---

STAGE 1 — COLD OPENER
Goal: get a reply.
Length: 5-10 words.
No links, no platform name, no pitch.
${openerExamples ? `\nGood:\n${openerExamples}` : ''}

Bad:
"Hi James, hope you're doing well! I came across your profile..."

---

STAGE 2 — VALUE + PITCH
Goal: deliver value AND introduce the service. Come to the point.
Length: 2-3 lines max.
Triggered: they replied with any interest.
${valueExamples ? `\nGood:\n${valueExamples}` : ''}

Bad:
"Great to hear! Here's a link to some opportunities. Let me know what you think and then I can tell you about our service..."

---

STAGE 3 — CLOSE
Goal: one ask. Done.
Length: 1 line.
Call OR payment link — never both.
${closeExamples ? `\nGood:\n${closeExamples}` : ''}

Bad:
"Please find below our subscription options for your consideration."

---

FOLLOW-UP (any stage):
- 1 follow-up max. No reply = move on.
- 5-8 words. No apology.

Good:
"Few of those filled — updated list."
"Still around if useful."

---

FORBIDDEN PHRASES:
${forbidden}
- More than one "?" per message
- Any exclamation point
- Any mention of pricing before close stage

ALWAYS:
- Start with their name OR a reaction to what they said — never a greeting
- Be specific — name something relevant to them
- End cleanly — no trailing "let me know!" or "happy to help!"
- Sound like you're continuing a conversation, not starting a pitch
`;
}

const FUNNEL_STAGES = {
  cold_opener:        { maxLines: 2, maxSentences: 2 },
  natural_response:   { maxLines: 2, maxSentences: 2 },
  value_pitch:        { maxLines: 4, maxSentences: 4 },
  close:              { maxLines: 2, maxSentences: 2 },
  follow_up:          { maxLines: 1, maxSentences: 1 },
};

function getLengthRule(messageStage) {
  return FUNNEL_STAGES[messageStage] || { maxLines: 4, maxSentences: 4 };
}

function validateMessageStyle(text) {
  const msg = workspace.getMessaging();
  const warnings = [];
  const lower = text.toLowerCase();

  let liveVoiceDna = null;
  try {
    const voiceDna = require('../services/voice-dna');
    liveVoiceDna = voiceDna.getCurrent(workspace.getId());
  } catch {}
  const effectiveVoiceDna = liveVoiceDna || msg.voice_dna || null;
  const learnedAvoid = Array.isArray(effectiveVoiceDna?.vocabulary_avoid)
    ? effectiveVoiceDna.vocabulary_avoid.map(p => String(p).toLowerCase())
    : [];
  const forbidden = [
    ...(msg.forbidden_phrases || []).map(p => p.toLowerCase()),
    ...learnedAvoid,
  ];
  forbidden.forEach(p => {
    if (p && lower.includes(p)) warnings.push(`Forbidden phrase: "${p}"`);
  });

  if ((text.match(/!/g) || []).length > 0) warnings.push('Exclamation point — remove it');
  if ((text.match(/\?/g) || []).length > 1) warnings.push('Multiple questions — pick one');

  const lines = text.trim().split('\n').filter(l => l.trim().length > 0);
  if (lines.length > 5) warnings.push(`${lines.length} lines — aim for 2-4 max`);

  const pricingWords = ['£', '$', '€', 'per month', 'per year', 'annual', 'monthly plan', 'upgrade', 'subscription'];
  pricingWords.forEach(w => {
    if (lower.includes(w)) warnings.push(`Pricing mentioned: "${w}"`);
  });

  return { valid: warnings.length === 0, warnings };
}

module.exports = { buildMessagingSkill, getLengthRule, validateMessageStyle };
