// src/test-routing.js
// Test the routing engine with sample conversations — no HeyReach connection needed
// Run: node src/test-routing.js

require('dotenv').config();
const claude = require('./services/claude');
const assets = require('./services/assets');

const testCases = [
  {
    name: 'Warm lead — IB analyst asking about PE roles',
    leadProfile: {
      name: 'James Okafor',
      role: 'Analyst at Goldman Sachs',
      company: 'Goldman Sachs',
      linkedInUrl: 'https://linkedin.com/in/james-okafor',
      currentStage: 'cold',
      lastAssetSent: null
    },
    thread: [
      { sender: 'us', text: "Hi James — noticed your GS background. We track unadvertised PE/IB analyst roles through InFeed. Happy to share a curated list if useful?", timestamp: '2025-01-10T09:00:00Z' },
      { sender: 'them', text: "Hey, yes that sounds interesting actually. I'm thinking about making a move this year.", timestamp: '2025-01-10T09:30:00Z' }
    ],
    expectedRouting: 'send_job_list'
  },
  {
    name: 'Hot lead — MBA student wanting a call',
    leadProfile: {
      name: 'Priya Sharma',
      role: 'MBA Student',
      company: 'London Business School',
      linkedInUrl: 'https://linkedin.com/in/priya-sharma',
      currentStage: 'warm',
      lastAssetSent: 'jl-ib-pe-2025'
    },
    thread: [
      { sender: 'us', text: "Hey Priya — I saw you're at LBS. We help students get early access to unadvertised finance roles. Want me to send a curated list?", timestamp: '2025-01-09T10:00:00Z' },
      { sender: 'them', text: "Yes please! I'm actively recruiting right now.", timestamp: '2025-01-09T10:20:00Z' },
      { sender: 'us', text: "Here's the list — 47 roles across IB and PE, including a few that aren't on LinkedIn yet: [link]", timestamp: '2025-01-09T10:35:00Z' },
      { sender: 'them', text: "This is really helpful. I've applied to three already. Can we get on a call to talk about premium access?", timestamp: '2025-01-10T08:00:00Z' }
    ],
    expectedRouting: 'book_call'
  },
  {
    name: 'Close lead — ready to buy',
    leadProfile: {
      name: 'Anya Petrova',
      role: 'Strategy Analyst',
      company: 'McKinsey',
      linkedInUrl: 'https://linkedin.com/in/anya-petrova',
      currentStage: 'hot',
      lastAssetSent: 'lp-premium'
    },
    thread: [
      { sender: 'them', text: "I've been using the free tier. It's genuinely useful. What does annual premium cost?", timestamp: '2025-01-10T14:00:00Z' }
    ],
    expectedRouting: 'send_payment_link'
  },
  {
    name: 'Frustrated lead — should escalate to human',
    leadProfile: {
      name: 'Mark Davies',
      role: 'VP Finance',
      company: 'HSBC',
      linkedInUrl: 'https://linkedin.com/in/mark-davies',
      currentStage: 'warm',
      lastAssetSent: null
    },
    thread: [
      { sender: 'us', text: "Hi Mark — we help finance professionals track unadvertised roles...", timestamp: '2025-01-08T09:00:00Z' },
      { sender: 'them', text: "I've received this exact message three times now. Please stop messaging me.", timestamp: '2025-01-10T11:00:00Z' }
    ],
    expectedRouting: 'human_takeover'
  }
];

async function runTests() {
  console.log('\n=== ROUTING ENGINE TEST ===\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  for (const tc of testCases) {
    console.log(`\n--- Test: ${tc.name} ---`);
    console.log(`Expected: ${tc.expectedRouting}`);

    try {
      const decision = await claude.classifyAndRoute(tc.thread, tc.leadProfile);
      const asset = assets.selectAsset(decision.routing_decision, decision.suggested_asset_segment);
      const draft = await claude.draftMessage(tc.thread, tc.leadProfile, decision, asset);

      const passed = decision.routing_decision === tc.expectedRouting;
      console.log(`Result: ${decision.routing_decision} [${passed ? '✓ PASS' : '✗ FAIL — expected ' + tc.expectedRouting}]`);
      console.log(`Stage: ${decision.stage} | Sentiment: ${decision.sentiment} | Confidence: ${decision.confidence}`);
      console.log(`Reason: ${decision.routing_reason}`);
      if (asset) console.log(`Asset: ${asset.name} (${asset.url})`);
      console.log(`\nDraft message:\n"${draft}"\n`);
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
    }
  }

  console.log('\n=== TEST COMPLETE ===\n');
}

runTests();
