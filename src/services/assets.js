// src/services/assets.js
// Asset library — loads from workspace config
// Payment links only served when creditsUsed >= 15

const workspace = require('./workspace');

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
  const ASSETS = getAssets();
  if (!ASSETS[category]) throw new Error(`Unknown asset category: ${category}`);
  const idx = ASSETS[category].findIndex(a => a.id === asset.id);
  if (idx >= 0) {
    ASSETS[category][idx] = { ...ASSETS[category][idx], ...asset };
  } else {
    ASSETS[category].push(asset);
  }
  return asset;
}

module.exports = { selectAsset, getAllAssets, upsertAsset };
