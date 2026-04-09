// src/services/assets.js
// Asset library — free trial model
// Payment links only served when creditsUsed >= 15

const ASSETS = {
  job_lists: [
    {
      id: 'jl-ib-pe-2025',
      name: 'IB & PE Analyst Roles — Q2 2025',
      segment: 'investment-banking-students',
      url: 'https://infeed.co/jobs/ib-pe-q2-2025',
      description: '47 curated IB and PE analyst roles across London and NYC, including unadvertised positions',
      tags: ['investment-banking', 'private-equity', 'analyst', 'london', 'nyc'],
      active: true
    },
    {
      id: 'jl-strategy-2025',
      name: 'Tech Strategy & Consulting Roles',
      segment: 'strategy-consulting',
      url: 'https://infeed.co/jobs/strategy-consulting-2025',
      description: '31 strategy and management consulting roles at top-tier firms and tech companies',
      tags: ['strategy', 'consulting', 'mckinsey', 'bcg', 'tech'],
      active: true
    },
    {
      id: 'jl-vc-2025',
      name: 'VC & Growth Equity Roles',
      segment: 'vc-aspiring',
      url: 'https://infeed.co/jobs/vc-growth-2025',
      description: '22 VC analyst and associate roles across early and growth-stage funds',
      tags: ['venture-capital', 'growth-equity', 'analyst', 'associate'],
      active: true
    },
    {
      id: 'jl-general',
      name: 'Top Graduate Finance & Strategy Roles',
      segment: 'general',
      url: 'https://infeed.co/jobs/top-roles',
      description: 'Curated list of high-quality finance, strategy, and tech roles for ambitious graduates',
      tags: ['general', 'graduate', 'finance', 'strategy'],
      active: true
    }
  ],

  // Free trial signup — this is what gets sent at upsell_trial stage
  trial_links: [
    {
      id: 'trial-standard',
      name: 'Free Trial — 20 Application Credits',
      url: 'https://infeed.co/trial',
      description: '20 free credits to try the application service — we handle CV, cover letter, and submission. You just pick the positions.',
      credits: 20,
      active: true
    }
  ],

  landing_pages: [
    {
      id: 'lp-employer-branding',
      name: 'Employer Branding Overview',
      offer: 'employer-branding',
      url: 'https://infeed.co/employers',
      description: 'How InFeed helps employers reach high-intent student talent across target universities',
      active: true
    },
    {
      id: 'lp-how-it-works',
      name: 'How InFeed Works',
      offer: 'general',
      url: 'https://infeed.co/how-it-works',
      description: 'Quick overview of the job list and application service for students',
      active: true
    }
  ],

  // Payment links — only used at trial_expiring and close stages
  payment_links: [
    {
      id: 'pay-applications-monthly',
      name: 'Application Service — Monthly',
      offer: 'applications-monthly',
      url: 'https://infeed.co/checkout/applications-monthly',
      description: 'Continue the application service — £49/month, cancel anytime',
      active: true
    },
    {
      id: 'pay-applications-annual',
      name: 'Application Service — Annual (save 30%)',
      offer: 'applications-annual',
      url: 'https://infeed.co/checkout/applications-annual',
      description: 'Annual application service at £399 — invoice auto-generates for employer reimbursement',
      active: true
    },
    {
      id: 'pay-employer',
      name: 'Employer Package',
      offer: 'employer-branding',
      url: 'https://infeed.co/employers/quote',
      description: 'Employer branding package — custom pricing',
      active: true
    }
  ],

  onboarding_links: [
    {
      id: 'onboard-trial',
      name: 'Start Your Free Trial',
      product: 'trial',
      url: 'https://infeed.co/onboard/trial',
      description: 'Set up your profile and start using your 20 free application credits',
      active: true
    }
  ],

  booking_links: [
    {
      id: 'book-call',
      name: 'Book a Call',
      url: 'https://cal.com/infeed/intro',
      description: '20-minute intro call',
      active: true
    }
  ]
};


// Select the right asset for routing decision + lead context
// creditsUsed is required to gate payment links correctly
function selectAsset(routingDecision, segment = 'general', creditsUsed = 0) {
  switch (routingDecision) {

    case 'send_job_list': {
      const list = ASSETS.job_lists.find(a => a.active && a.segment === segment)
        || ASSETS.job_lists.find(a => a.active && a.segment === 'general');
      return list ? { ...list, type: 'job_list' } : null;
    }

    case 'send_trial_link': {
      // Only send trial link if they haven't started a trial yet
      if (creditsUsed > 0) return null;
      const trial = ASSETS.trial_links.find(a => a.active);
      return trial ? { ...trial, type: 'trial_link' } : null;
    }

    case 'send_onboarding_link': {
      const onboard = ASSETS.onboarding_links.find(a => a.active);
      return onboard ? { ...onboard, type: 'onboarding_link' } : null;
    }

    case 'send_payment_link': {
      // Hard gate: never send payment link before 15 credits used
      if (creditsUsed < 15) {
        console.warn(`[Assets] Payment link requested but only ${creditsUsed} credits used — returning trial link instead`);
        const trial = ASSETS.trial_links.find(a => a.active);
        return trial ? { ...trial, type: 'trial_link' } : null;
      }
      const isEmployer = segment === 'employer-branding';
      const link = ASSETS.payment_links.find(a =>
        a.active && (isEmployer ? a.offer === 'employer-branding' : a.offer === 'applications-annual')
      );
      return link ? { ...link, type: 'payment_link' } : null;
    }

    case 'book_call': {
      const booking = ASSETS.booking_links.find(a => a.active);
      return booking ? { ...booking, type: 'booking_link' } : null;
    }

    case 'send_landing_page': {
      const isEmployer = segment === 'employer-branding';
      const page = ASSETS.landing_pages.find(a =>
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
  return ASSETS;
}

function upsertAsset(category, asset) {
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
