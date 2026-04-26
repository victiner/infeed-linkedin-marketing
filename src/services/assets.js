// src/services/assets.js
// Asset library — loads from workspace config (workspaces/<id>/workspace.json).
// Mutations (upsert, toggle, remove) write back to disk and reload the workspace cache so
// the change is live in subsequent draft prompts without a server restart.
// Payment links only served when creditsUsed >= 15.

const fs = require('fs');
const path = require('path');
const workspace = require('./workspace');

const WORKSPACES_DIR = path.join(__dirname, '..', '..', 'workspaces');

const VALID_CATEGORIES = new Set([
  'job_lists', 'trial_links', 'landing_pages', 'payment_links', 'onboarding_links', 'booking_links',
]);

function workspacePath(id) {
  return path.join(WORKSPACES_DIR, id, 'workspace.json');
}

// Read the on-disk workspace.json for the active workspace, mutate via callback, write back, reload cache.
function _persistMutation(mutate) {
  const id = workspace.getId();
  const p = workspacePath(id);
  if (!fs.existsSync(p)) throw new Error(`Workspace file not found: ${p}`);
  const ws = JSON.parse(fs.readFileSync(p, 'utf-8'));
  ws.assets = ws.assets || {};
  const result = mutate(ws);
  fs.writeFileSync(p, JSON.stringify(ws, null, 2));
  workspace.reload(id); // re-cache so getAssets() reflects the change immediately
  return result;
}

function getAssets() {
  return workspace.getAssets();
}

// Select the right asset for routing decision + lead context
// creditsUsed is required to gate payment links correctly
function selectAsset(routingDecision, segment = 'general', creditsUsed = 0) {
  const ASSETS = getAssets();

  switch (routingDecision) {

    case 'send_job_list': {
      const list = (ASSETS.job_lists || []).find(a => a.active && a.segment === segment)
        || (ASSETS.job_lists || []).find(a => a.active && a.segment === 'general');
      return list ? { ...list, type: 'job_list' } : null;
    }

    case 'send_trial_link': {
      if (creditsUsed > 0) return null;
      const trial = (ASSETS.trial_links || []).find(a => a.active);
      return trial ? { ...trial, type: 'trial_link' } : null;
    }

    case 'send_onboarding_link': {
      const onboard = (ASSETS.onboarding_links || []).find(a => a.active);
      return onboard ? { ...onboard, type: 'onboarding_link' } : null;
    }

    case 'send_payment_link': {
      // Hard gate: never send payment link before 15 credits used
      if (creditsUsed < 15) {
        console.warn(`[Assets] Payment link requested but only ${creditsUsed} credits used — returning trial link instead`);
        const trial = (ASSETS.trial_links || []).find(a => a.active);
        return trial ? { ...trial, type: 'trial_link' } : null;
      }
      const isEmployer = segment === 'employer-branding';
      const link = (ASSETS.payment_links || []).find(a =>
        a.active && (isEmployer ? a.offer === 'employer-branding' : a.offer === 'applications-annual')
      );
      return link ? { ...link, type: 'payment_link' } : null;
    }

    case 'book_call': {
      const booking = (ASSETS.booking_links || []).find(a => a.active);
      return booking ? { ...booking, type: 'booking_link' } : null;
    }

    case 'send_landing_page': {
      const isEmployer = segment === 'employer-branding';
      const page = (ASSETS.landing_pages || []).find(a =>
        a.active && (isEmployer ? a.offer === 'employer-branding' : true)
      );
      return page ? { ...page, type: 'landing_page' } : null;
    }

    case 'human_takeover':
    case 'no_action':
      return null;

    default:
      return null;
  }
}

function getAllAssets() {
  return getAssets();
}

function upsertAsset(category, asset) {
  if (!VALID_CATEGORIES.has(category)) throw new Error(`Unknown asset category: ${category}`);
  return _persistMutation(ws => {
    if (!ws.assets[category]) ws.assets[category] = [];
    const list = ws.assets[category];
    const idx = list.findIndex(a => a.id === asset.id);
    let merged;
    if (idx >= 0) {
      merged = { ...list[idx], ...asset };
      list[idx] = merged;
    } else {
      merged = { active: true, ...asset };
      list.push(merged);
    }
    return merged;
  });
}

function setAssetActive(category, id, active) {
  if (!VALID_CATEGORIES.has(category)) throw new Error(`Unknown asset category: ${category}`);
  return _persistMutation(ws => {
    const list = ws.assets[category] || [];
    const item = list.find(a => a.id === id);
    if (!item) throw new Error(`Asset not found: ${category}/${id}`);
    item.active = !!active;
    return item;
  });
}

function removeAsset(category, id) {
  if (!VALID_CATEGORIES.has(category)) throw new Error(`Unknown asset category: ${category}`);
  return _persistMutation(ws => {
    const list = ws.assets[category] || [];
    const idx = list.findIndex(a => a.id === id);
    if (idx < 0) throw new Error(`Asset not found: ${category}/${id}`);
    const [removed] = list.splice(idx, 1);
    return removed;
  });
}

// Routing decisions that require an attached asset to function as designed.
// If no active asset is available for one of these, the router demotes routing
// to 'no_action' so Claude can still respond, follow up, or answer naturally —
// just without trying to attach a link/list it doesn't have.
const ASSET_REQUIRED_ROUTES = new Set([
  'send_job_list', 'send_trial_link', 'send_onboarding_link',
  'send_payment_link', 'send_landing_page', 'book_call',
]);

module.exports = { selectAsset, getAllAssets, upsertAsset, setAssetActive, removeAsset, ASSET_REQUIRED_ROUTES };
