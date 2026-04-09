# LinkedIn Nurture System — Setup Guide

## What you're setting up
A LinkedIn DM conversion system that:
1. Receives inbound LinkedIn replies via HeyReach webhooks
2. Classifies leads and routes them with Claude
3. Drafts personalised replies
4. Queues them for your review (or auto-sends when confidence is high)

---

## SUBSCRIPTIONS & ACCOUNTS YOU NEED

### 1. HeyReach — REQUIRED ($79/month)
**What it does:** Connects your LinkedIn account, sends/receives DMs, fires webhooks

**Steps:**
1. Sign up at https://app.heyreach.io/account/register
2. Connect your LinkedIn account (follow their guide — it uses a browser session)
3. Go to **Settings → Integrations → API**
4. Click **New API Key** → copy the key
5. Add to your `.env` as `HEYREACH_API_KEY=...`

**Webhook setup (do this after your server is running):**
1. Go to **Settings → Integrations → Webhooks**
2. Click **Add Webhook**
3. URL: `https://YOUR-SERVER-URL/webhook/heyreach`
4. Events to enable: `MESSAGE_REPLY_RECEIVED`, `INMAIL_REPLY_RECEIVED`, `CONNECTION_REQUEST_ACCEPTED`
5. Secret: use the same value as `WEBHOOK_SECRET` in your `.env`

---

### 2. Anthropic Claude API — REQUIRED (pay-as-you-go, ~$5–20/month)
**What it does:** Classifies leads, makes routing decisions, drafts messages

**Steps:**
1. Go to https://console.anthropic.com
2. Create an account and add a payment method
3. Go to **Settings → API Keys → Create Key**
4. Copy the key (starts with `sk-ant-...`)
5. Add to your `.env` as `ANTHROPIC_API_KEY=...`

**Expected cost:** Each conversation processed costs roughly $0.002–0.005 in API calls (2 Claude calls per message: classify + draft). At 100 leads/month that's under $1.

---

### 3. Server to run the Node.js app — REQUIRED
**Options (pick one):**

#### Option A: Railway (easiest, ~$5/month)
1. Go to https://railway.app
2. Connect your GitHub repo (push this code to GitHub first)
3. Railway auto-detects Node.js and deploys
4. Add environment variables in Railway's dashboard (copy from `.env`)
5. Your server URL will be something like `https://your-app.railway.app`

#### Option B: Render (free tier available)
1. Go to https://render.com
2. New → Web Service → connect GitHub repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables in Render dashboard

#### Option C: Run locally with ngrok (for testing only)
```bash
npm install
cp .env.example .env
# Fill in .env with your keys
npm start
# In another terminal:
ngrok http 3000
# Use the ngrok URL as your webhook URL in HeyReach
```

---

### 4. n8n (OPTIONAL but recommended for the full automation flow)
**What it does:** Orchestrates the webhook → Claude → backend pipeline visually

**Options:**
- **n8n Cloud:** https://n8n.io (free trial, then ~$20/month)
- **Self-hosted on Railway:** Deploy from https://railway.app/template/n8n — free/cheap
- **Skip n8n entirely:** The Node.js server handles everything directly via webhooks. n8n is only needed if you want a visual flow editor.

**If using n8n:**
1. Import `n8n/workflow.json` via n8n UI → Import Workflow
2. Set up credentials:
   - HeyReach: HTTP Header Auth, header name `X-API-KEY`, value = your HeyReach API key
   - Anthropic: HTTP Header Auth, header name `x-api-key`, value = your Anthropic key
3. Update the Slack webhook URL (or remove that node if not using Slack)
4. Activate the workflow

---

## INSTALLATION

```bash
# Clone/download the project
cd linkedin-nurture

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Open .env and fill in your values

# Test the routing engine (requires ANTHROPIC_API_KEY)
npm test

# Start the server
npm start

# Development mode (auto-restarts on changes)
npm run dev
```

---

## VERIFY IT'S WORKING

### 1. Health check
```
GET https://YOUR-SERVER/health
```
Should return: `{ status: "ok", anthropicConfigured: true, heyreachConfigured: true }`

### 2. Test routing
```bash
npm test
```
Runs 4 test conversations through Claude and shows routing decisions + draft messages.

### 3. Simulate a webhook
```bash
curl -X POST https://YOUR-SERVER/webhook/heyreach \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: YOUR_WEBHOOK_SECRET" \
  -d '{
    "eventType": "MESSAGE_REPLY_RECEIVED",
    "conversationId": "test-123",
    "linkedInAccountId": "sender-456",
    "leadLinkedInUrl": "https://linkedin.com/in/test-lead",
    "leadName": "Test Lead",
    "leadTitle": "Analyst at Goldman Sachs",
    "leadCompany": "Goldman Sachs",
    "messageText": "Hey, this sounds interesting. I am thinking about making a PE move this year.",
    "timestamp": "2025-01-10T09:00:00Z"
  }'
```

Then check:
```
GET https://YOUR-SERVER/api/conversations
```
You should see the conversation with a pending draft.

---

## API REFERENCE

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Server health check |
| POST | /webhook/heyreach | HeyReach webhook entry point |
| GET | /api/conversations | All conversations with drafts |
| GET | /api/conversations/:id | Single conversation |
| POST | /api/conversations/:id/process | Re-process a conversation |
| POST | /api/conversations/:id/send | Send an approved draft |
| POST | /api/conversations/:id/takeover | Flag for human |
| POST | /api/conversations/:id/route | Override routing |
| GET | /api/leads | All leads |
| GET | /api/leads/:id | Single lead |
| PATCH | /api/leads/:id | Update lead (stage, converted, etc.) |
| GET | /api/assets | Asset library |
| GET | /api/assets/select?routing=send_job_list&segment=ib | Select best asset |
| POST | /api/assets/:category | Add/update an asset |
| GET | /api/analytics/linkedin-funnel | Funnel stats |
| GET | /api/analytics/actions | Action log |
| GET | /api/playbook | Current playbook config |
| POST | /api/playbook | Update playbook config |

---

## UPDATING YOUR ASSETS

Edit `src/services/assets.js` to add your real job list URLs, landing pages, payment links, and onboarding links. Replace the placeholder `infeed.co` URLs with your actual URLs.

Or POST to `/api/assets/:category` at runtime:
```json
POST /api/assets/job_lists
{
  "id": "jl-new-q3",
  "name": "IB Roles — Q3 2025",
  "segment": "investment-banking-students",
  "url": "https://your-actual-url.com/jobs/ib-q3",
  "description": "Updated list of 52 IB roles",
  "active": true
}
```

---

## PRODUCTION CHECKLIST

- [ ] HeyReach account connected with your LinkedIn
- [ ] Anthropic API key added to .env
- [ ] Server deployed (Railway or Render)
- [ ] Webhook URL registered in HeyReach with secret
- [ ] Webhook tested with curl simulation
- [ ] `npm test` passes all 4 routing tests
- [ ] Real asset URLs added in assets.js
- [ ] Playbook tone/rules reviewed at /api/playbook
- [ ] Decision: auto-send (confidence >= 0.85) or manual review for all?

---

## COST SUMMARY

| Service | Cost | Notes |
|---------|------|-------|
| HeyReach | $79/month | 1 LinkedIn seat |
| Claude API | ~$5–20/month | Pay-as-you-go at volume |
| Railway/Render | $5–20/month | Server hosting |
| n8n (optional) | $0–20/month | Self-hosted = free |
| **Total** | **~$90–140/month** | |

---

## SUPPORT & NEXT STEPS

1. **Add a database:** Swap `src/services/store.js` for a Postgres/Airtable/Google Sheets adapter using the same interface
2. **Add a UI:** The dashboard artifact from the conversation can be wired to this API
3. **Add MCP:** Connect HeyReach MCP to Claude Desktop for manual message drafting alongside the automated flow
4. **Add email notifications:** When a draft is queued, send yourself an email via SendGrid or Resend (free tiers available)
