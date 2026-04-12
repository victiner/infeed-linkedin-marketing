// src/routes/leads.js
const express = require('express');
const router = express.Router();
const store = require('../services/store');

// GET /leads
router.get('/', (req, res) => {
  const { stage, limit = 50 } = req.query;
  let leads = store.getAllLeads();
  if (stage) leads = leads.filter(l => l.stage === stage);
  res.json({ leads: leads.slice(0, parseInt(limit)), total: leads.length });
});

// GET /leads/:id
router.get('/:id', (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json({ lead });
});

// PATCH /leads/:id — update stage, tags, etc.
router.patch('/:id', (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const { stage, callBooked, converted } = req.body;
  if (stage) store.updateLeadStage(req.params.id, stage);
  if (callBooked !== undefined) lead.callBooked = callBooked;
  if (converted !== undefined) lead.converted = converted;

  res.json({ lead: store.getLead(req.params.id) });
});

// POST /leads/:id/use-credit — record that one application was handled
router.post('/:id/use-credit', (req, res) => {
  const lead = store.useCredit(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const status = store.getCreditStatus(req.params.id);
  res.json({ success: true, credits: status });
});

// GET /leads/:id/credits — check credit status
router.get('/:id/credits', (req, res) => {
  const status = store.getCreditStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Lead not found' });
  res.json(status);
});

// POST /leads/import — manually import a lead and optionally send cold opener
router.post('/import', async (req, res) => {
  const { linkedInUrl, name, role, company, sendColdOpener, senderId } = req.body;
  if (!linkedInUrl || !name) return res.status(400).json({ error: 'linkedInUrl and name are required' });

  try {
    // Resolve sender ID — use provided, or skip (cold opener won't send without one)
    let resolvedSenderId = senderId || process.env.HEYREACH_DEFAULT_SENDER_ID || '';

    // Create lead
    const lead = store.upsertLead({
      linkedInUrl, name, role: role || '', company: company || '',
      senderId: resolvedSenderId || '', tags: []
    });

    // Assign to an active campaign if one exists
    const campaigns = require('../services/campaigns');
    const match = campaigns.findCampaignForLead(lead);
    if (match && match.isNew) {
      store.assignLeadToCampaign(lead.id, match.campaign.id);
      lead.campaignId = match.campaign.id;
    }

    // Optionally send cold opener via HeyReach
    let sent = false;
    if (sendColdOpener && resolvedSenderId) {
      const claude = require('../services/claude');
      const heyreach = require('../services/heyreach');

      const leadProfile = {
        name: lead.name, role: lead.role, company: lead.company,
        linkedInUrl: lead.linkedInUrl, currentStage: 'cold', funnelStage: 'cold_opener',
        lastAssetSent: null, creditsUsed: 0, creditsTotal: 20,
        trialStarted: false, trialExpired: false,
        responseVelocity: { avgMinutes: null, fastResponder: false, messageCount: 0 }
      };

      // Get campaign step template if available
      const step = campaigns.getCurrentStep(lead);
      const templateGuidance = step?.template || null;

      // Classify and draft
      const routingDecision = {
        stage: 'cold', funnel_stage: 'cold_opener', sentiment: 'neutral',
        intent: 'Initial outreach', routing_decision: 'no_action',
        routing_reason: 'Cold opener', confidence: 0.95, is_follow_up: false
      };

      let draftText;
      if (step && !step.useAI && step.template) {
        draftText = campaigns.renderTemplate(step.template, lead);
      } else {
        draftText = await claude.draftMessage([], leadProfile, routingDecision, null, templateGuidance);
      }

      // Create conversation + draft
      const convoId = `import-${lead.id}`;
      store.upsertConversation({ conversationId: convoId, leadId: lead.id, senderId: resolvedSenderId, messages: [] });
      const convoWithDraft = store.addDraftToConversation(convoId, {
        text: draftText, routingDecision, asset: null, autoSendEligible: true
      });
      const storedDraft = convoWithDraft.drafts[convoWithDraft.drafts.length - 1];

      // Send via HeyReach
      try {
        const delayMs = Math.floor(Math.random() * 10_000); // shorter delay for imports
        await new Promise(r => setTimeout(r, delayMs));
        await heyreach.sendMessage({ senderId: resolvedSenderId, conversationId: convoId, message: draftText });
        store.markDraftSent(convoId, storedDraft.id);
        store.logAction({
          type: 'message_sent', leadId: lead.id, conversationId: convoId,
          data: { routing: 'cold_opener', stage: 'cold', autoSent: true, source: 'import' },
          result: 'sent'
        });
        if (lead.campaignId) store.advanceLeadStep(lead.id);
        sent = true;
      } catch (err) {
        console.error(`[Import] Send failed for ${name}:`, err.message);
        store.logAction({
          type: 'draft_created', leadId: lead.id, conversationId: convoId,
          data: { routing: 'cold_opener', sendFailed: true, error: err.message, source: 'import' },
          result: 'draft_ready'
        });
      }

      res.json({ success: true, lead, draft: draftText, sent, conversationId: convoId });
    } else {
      res.json({ success: true, lead, sent: false });
    }
  } catch (err) {
    console.error('[Import] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


// ---- ASSETS ----
// src/routes/assets.js is inlined here for brevity as a separate export

const assetsRouter = express.Router();
const assetService = require('../services/assets');

assetsRouter.get('/', (req, res) => {
  res.json(assetService.getAllAssets());
});

assetsRouter.get('/select', (req, res) => {
  const { routing, segment } = req.query;
  if (!routing) return res.status(400).json({ error: 'routing param required' });
  const asset = assetService.selectAsset(routing, segment || 'general');
  res.json({ asset });
});

assetsRouter.get('/:id/stats', (req, res) => {
  const stats = store.getAssetStats(req.params.id);
  res.json(stats);
});

assetsRouter.post('/:category', (req, res) => {
  try {
    const body = req.body;
    if (!body.id) {
      body.id = `${req.params.category.replace(/_/g, '-')}-${Date.now()}`;
    }
    const asset = assetService.upsertAsset(req.params.category, body);
    res.json({ success: true, asset });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports.assetsRouter = assetsRouter;


// ---- ANALYTICS ----
const analyticsRouter = express.Router();

analyticsRouter.get('/linkedin-funnel', (req, res) => {
  res.json(store.getAnalytics());
});

analyticsRouter.get('/actions', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ actions: store.getActionLog(limit) });
});

analyticsRouter.get('/heyreach', async (_req, res) => {
  try {
    const heyreach = require('../services/heyreach');
    const [overallRes, campaignsRes] = await Promise.allSettled([
      heyreach.getOverallStats(),
      heyreach.getCampaigns()
    ]);
    res.json({
      overall:        overallRes.status   === 'fulfilled' ? overallRes.value   : null,
      campaigns:      campaignsRes.status === 'fulfilled' ? campaignsRes.value : null,
      overallError:   overallRes.status   === 'rejected'  ? overallRes.reason.message   : null,
      campaignsError: campaignsRes.status === 'rejected'  ? campaignsRes.reason.message : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports.analyticsRouter = analyticsRouter;


// ---- PLAYBOOK ----
// In-memory playbook config — extend to DB as needed
const playbookRouter = express.Router();

let playbook = {
  tone: 'warm, direct, value-first',
  openingStyle: 'Never open with a hard pitch',
  jobListFraming: 'Curated for your background, no strings attached',
  rules: {
    leadWithJobListForWarm: true,
    bookCallForHot: true,
    sendPaymentForClose: true,
    humanTakeoverOnFrustrated: false
  },
  autoSendThreshold: 0.85,
  stageDefinitions: {
    cold: '0 replies, no prior interaction',
    warm: '1-2 replies, positive/curious tone',
    hot: '3+ replies or asked a specific question',
    close: 'Mentioned budget/timeline/pricing/access',
    nurture: 'Engaged but needs more time'
  }
};

playbookRouter.get('/', (req, res) => res.json(playbook));

playbookRouter.post('/', (req, res) => {
  playbook = { ...playbook, ...req.body };
  res.json({ success: true, playbook });
});

module.exports.playbookRouter = playbookRouter;


// ---- CAMPAIGNS ----
const campaignsRouter = express.Router();
const campaignService = require('../services/campaigns');
const heyreach        = require('../services/heyreach');

// GET /campaigns — list all
campaignsRouter.get('/', (_req, res) => {
  res.json({ campaigns: campaignService.getAllCampaigns() });
});

// GET /campaigns/heyreach-list — fetch live HeyReach campaigns for the linker dropdown
campaignsRouter.get('/heyreach-list', async (_req, res) => {
  try {
    const data = await heyreach.getCampaigns();
    const items = data?.items || data || [];
    res.json({ campaigns: items });
  } catch (err) {
    res.status(200).json({ campaigns: [], error: err.message });
  }
});

// GET /campaigns/:id
campaignsRouter.get('/:id', (req, res) => {
  const c = campaignService.getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  res.json({ campaign: c });
});

// POST /campaigns — create
campaignsRouter.post('/', (req, res) => {
  try {
    const campaign = campaignService.createCampaign(req.body);
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /campaigns/:id — update (name, segment, status, steps, etc.)
campaignsRouter.patch('/:id', (req, res) => {
  const campaign = campaignService.updateCampaign(req.params.id, req.body);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json({ success: true, campaign });
});

// DELETE /campaigns/:id
campaignsRouter.delete('/:id', (req, res) => {
  const ok = campaignService.deleteCampaign(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Campaign not found' });
  res.json({ success: true });
});

module.exports.campaignsRouter = campaignsRouter;
