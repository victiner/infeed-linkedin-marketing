# LinkedIn Nurture System

> AI-powered LinkedIn DM conversion infrastructure — value-led, Claude-routed.

Turns LinkedIn conversations into the right next action: job list, call booking, landing page, payment link, or onboarding — automatically, with a human-review step before sending.

---

## Architecture

```
LinkedIn DM reply
      │
      ▼
HeyReach webhook ──► Node.js backend ──► Claude API
                           │                  │
                           │            ┌─────┴──────┐
                           │            │ Classify   │
                           │            │ Route      │
                           │            │ Draft msg  │
                           │            └─────┬──────┘
                           │                  │
                           ▼                  ▼
                      Asset library    Draft queued
                           │                  │
                           └──────────────────┘
                                      │
                                      ▼
                              Dashboard review
                                      │
                              ┌───────┴───────┐
                              │   Approve     │
                              │   Edit        │
                              │   Takeover    │
                              └───────┬───────┘
                                      │
                                      ▼
                           HeyReach sends message
```

## Files

```
linkedin-nurture/
├── src/
│   ├── server.js                  # Express app entry point
│   ├── prompts/
│   │   └── routing.js             # All Claude prompts
│   ├── services/
│   │   ├── claude.js              # Claude API wrapper
│   │   ├── heyreach.js            # HeyReach API wrapper
│   │   ├── router.js              # Core routing engine
│   │   ├── assets.js              # Asset library (job lists, pages, links)
│   │   ├── store.js               # Lead/conversation store (swap for DB)
│   │   └── poller.js              # Inbox poller (alternative to webhooks)
│   ├── routes/
│   │   ├── webhook.js             # HeyReach webhook receiver
│   │   ├── conversations.js       # Conversation API
│   │   └── leads.js               # Leads, assets, analytics, playbook APIs
│   ├── middleware/
│   │   └── dashboard.js           # Serves built React dashboard
│   └── test-routing.js            # Test routing with sample convos
├── dashboard/                     # React dashboard UI
│   └── src/
│       ├── App.js                 # Full dashboard (4 panels)
│       ├── index.js
│       └── services/api.js        # All API calls
├── n8n/
│   └── workflow.json              # Importable n8n automation workflow
├── docs/
│   └── SETUP.md                   # Complete setup guide with all credentials
├── .env.example                   # Environment variables template
├── railway.toml                   # Railway deployment config
├── render.yaml                    # Render deployment config
└── package.json
```

## Quick start

```bash
# 1. Set up environment
cp .env.example .env
# Fill in ANTHROPIC_API_KEY, HEYREACH_API_KEY, WEBHOOK_SECRET

# 2. Install and run
npm install
npm start

# 3. Test routing (needs ANTHROPIC_API_KEY)
npm test

# 4. (Optional) Build dashboard
cd dashboard && npm install && npm run build && cd ..
# Then open http://localhost:3000
```

## Credentials needed

| What | Where to get | Cost |
|------|-------------|------|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | Pay-as-you-go |
| `HEYREACH_API_KEY` | app.heyreach.io → Integrations | $79/mo plan |
| `WEBHOOK_SECRET` | Set any random string | Free |

See `docs/SETUP.md` for the complete step-by-step.

## Routing outcomes

| Outcome | When |
|---------|------|
| `send_job_list` | Warm lead, relevant background, no prior CTA |
| `book_call` | Hot lead, 3+ replies, asked questions |
| `send_landing_page` | Cold/warm, needs context first |
| `send_payment_link` | Close lead, signalled buying intent |
| `send_onboarding_link` | Converted, ready to activate |
| `human_takeover` | Frustrated, complex objection, pricing |
