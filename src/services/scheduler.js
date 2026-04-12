// src/services/scheduler.js
// Campaign step scheduler — checks every 60s for leads whose next step delay has elapsed
// and proactively sends the next message (without waiting for a reply).

const store = require('./store');
const campaigns = require('./campaigns');
const { sendProactiveStep } = require('./router');
const workspace = require('./workspace');

let timer = null;
const INTERVAL_MS = 60_000; // check every 60s

async function tick() {
  // Iterate every workspace — the scheduler handles campaigns across all businesses
  const allWorkspaces = workspace.list();

  for (const ws of allWorkspaces) {
    await workspace.runInContext(ws.id, async () => {
      await tickForWorkspace(ws.id);
    });
  }
}

async function tickForWorkspace(wsId) {
  const activeCampaigns = campaigns.getActiveCampaigns(wsId);
  if (activeCampaigns.length === 0) return;

  for (const campaign of activeCampaigns) {
    const leadsInCampaign = store.getLeadsInCampaign(campaign.id);

    for (const lead of leadsInCampaign) {
      // Skip leads who have completed all steps
      const step = campaigns.getCurrentStep(lead);
      if (!step) continue;

      // Skip if delay hasn't elapsed yet
      if (!campaigns.isStepDelayElapsed(lead)) continue;

      // Don't re-send if converted or human-takeover
      if (lead.converted) continue;

      // Skip leads from a different workspace (safety check — shouldn't happen since campaigns are workspace-scoped)
      if (lead.workspaceId && lead.workspaceId !== wsId) continue;

      console.log(`[Scheduler] Step ${step._stepIndex + 1} due for ${lead.name} [${wsId}] (campaign: ${campaign.name})`);

      try {
        const result = await sendProactiveStep(lead);
        if (result) {
          console.log(`[Scheduler] Sent step ${step._stepIndex + 1} to ${lead.name} [${wsId}]: ${result.action}`);
        }
      } catch (err) {
        console.error(`[Scheduler] Failed to send step for ${lead.name} [${wsId}]:`, err.message);
      }

      // Small delay between sends to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function start() {
  if (timer) return;
  console.log('[Scheduler] Campaign step scheduler started (checking every 60s)');
  // First tick after 10s (let server finish startup)
  setTimeout(() => {
    tick().catch(err => console.error('[Scheduler] Tick error:', err.message));
    timer = setInterval(() => {
      tick().catch(err => console.error('[Scheduler] Tick error:', err.message));
    }, INTERVAL_MS);
  }, 10_000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[Scheduler] Stopped');
  }
}

module.exports = { start, stop, tick };
