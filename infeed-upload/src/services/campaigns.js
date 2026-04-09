// src/services/campaigns.js
// Campaign store + campaign↔lead matching logic
//
// A campaign is a named sequence of message steps tied to a target segment.
// Each step maps a funnel stage to a message template + routing action + delay.
// The AI uses the template as guidance unless useAI is false, in which case
// the template text is sent verbatim.

const { v4: uuidv4 } = require('uuid');
const store = require('./store');

const campaigns = new Map();

const DEFAULT_STEPS = [
  { stage: 'cold_opener',  template: '',  routing: null,              delayHours: 0,  useAI: true, assetCategory: null },
  { stage: 'value_pitch',  template: '',  routing: 'send_job_list',   delayHours: 24, useAI: true, assetCategory: 'job_lists' },
  { stage: 'close',        template: '',  routing: 'send_payment_link', delayHours: 48, useAI: true, assetCategory: 'payment_links' },
];

// ---- CRUD ----

function createCampaign({ name, segment, heyreachCampaignId, heyreachCampaignName, steps }) {
  const id = uuidv4();
  const now = new Date().toISOString();
  const campaign = {
    id,
    name:                  name || 'Untitled campaign',
    segment:               segment || 'general',
    heyreachCampaignId:    heyreachCampaignId  || null,
    heyreachCampaignName:  heyreachCampaignName || null,
    status:                'draft',
    steps:                 steps || DEFAULT_STEPS.map(s => ({ ...s, id: uuidv4() })),
    createdAt:             now,
    updatedAt:             now,
  };
  campaigns.set(id, campaign);
  return campaign;
}

function updateCampaign(id, updates) {
  const c = campaigns.get(id);
  if (!c) return null;
  Object.assign(c, updates, { updatedAt: new Date().toISOString() });
  campaigns.set(id, c);
  return c;
}

function deleteCampaign(id) {
  return campaigns.delete(id);
}

function getCampaign(id) {
  return campaigns.get(id) || null;
}

function getAllCampaigns() {
  return [...campaigns.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getActiveCampaigns() {
  return [...campaigns.values()].filter(c => c.status === 'active');
}

// ---- MATCHING: find the right campaign for a lead ----

/**
 * Match a lead to an active campaign.
 * Priority:
 *   1. Lead already has a campaignId → return that campaign (if still active)
 *   2. HeyReach campaign ID from webhook payload matches a linked campaign
 *   3. Segment match: lead's tags/segment overlaps campaign segment
 *   4. Fallback: first active 'general' campaign
 * Returns { campaign, isNew } or null.
 */
function findCampaignForLead(lead, webhookPayload = {}) {
  // 1. Already assigned?
  if (lead.campaignId) {
    const existing = campaigns.get(lead.campaignId);
    if (existing && existing.status === 'active') return { campaign: existing, isNew: false };
    // Campaign paused/deleted — fall through to re-match
  }

  const active = getActiveCampaigns();
  if (active.length === 0) return null;

  // 2. HeyReach campaign ID match
  const hrCampaignId = webhookPayload.campaignId || webhookPayload.campaign_id || null;
  if (hrCampaignId) {
    const match = active.find(c => String(c.heyreachCampaignId) === String(hrCampaignId));
    if (match) return { campaign: match, isNew: true };
  }

  // 3. Segment match from lead tags
  const leadSegments = (lead.tags || []).map(t => t.toLowerCase());
  for (const c of active) {
    if (c.segment !== 'general' && leadSegments.includes(c.segment.toLowerCase())) {
      return { campaign: c, isNew: true };
    }
  }

  // 4. Fallback to first general campaign
  const general = active.find(c => c.segment === 'general') || active[0];
  return { campaign: general, isNew: true };
}

// ---- STEP RESOLUTION ----

/**
 * Get the current step config for a lead inside their campaign.
 * Returns the step object or null if the lead has completed all steps.
 */
function getCurrentStep(lead) {
  if (!lead.campaignId) return null;
  const campaign = campaigns.get(lead.campaignId);
  if (!campaign || campaign.status !== 'active') return null;
  const idx = lead.currentStepIndex || 0;
  if (idx >= campaign.steps.length) return null;
  return { ...campaign.steps[idx], _campaignId: campaign.id, _stepIndex: idx, _totalSteps: campaign.steps.length };
}

/**
 * Check if a lead's next proactive step delay has elapsed.
 * Used by the scheduler to send follow-ups without waiting for a reply.
 */
function isStepDelayElapsed(lead) {
  if (!lead.campaignId || !lead.lastStepAt) return false;
  const step = getCurrentStep(lead);
  if (!step) return false;
  const elapsedMs = Date.now() - new Date(lead.lastStepAt).getTime();
  const delayMs = (step.delayHours || 0) * 3600_000;
  return elapsedMs >= delayMs;
}

/**
 * Replace template placeholders with lead data.
 * Supports: {firstName}, {name}, {company}, {role}
 */
function renderTemplate(template, lead) {
  if (!template) return '';
  const firstName = (lead.name || '').split(' ')[0] || 'there';
  return template
    .replace(/\{firstName\}/gi, firstName)
    .replace(/\{name\}/gi, lead.name || '')
    .replace(/\{company\}/gi, lead.company || '')
    .replace(/\{role\}/gi, lead.role || '');
}

module.exports = {
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaign,
  getAllCampaigns,
  getActiveCampaigns,
  findCampaignForLead,
  getCurrentStep,
  isStepDelayElapsed,
  renderTemplate,
  DEFAULT_STEPS,
};
