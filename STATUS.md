# InFeed — Project Status

**Last updated:** 2026-05-16
**State:** Live pipeline operational with trained voice. Conversation display + HeyReach thread sync just landed — all outbound (cold opener, reply, follow-up) shows in the dashboard. First real lead (Krisztina) queued in HeyReach.

---

## Quick read: where you are

You can import a real lead via the InFeed dashboard with cold opener ON, and:
1. Claude drafts a personalized cold opener using your trained matrix-cell data (voice DNA + canonical examples + corrections + annotations)
2. The draft is queued to HeyReach campaign 432820 → list 673244
3. HeyReach dispatches the LinkedIn DM within its scheduling window (minutes to hours)
4. When the lead replies, the HeyReach webhook fires → router classifies → Claude drafts response → queued for review in Conversations panel

End-to-end validated 2026-05-16 07:50 with lead "Krisztina Toth" — draft pulled from `analyst__cold_opener__neutral` matrix cell (exact match), 23 training records fed the prompt.

---

## Live config (Railway env vars)

| Variable | Current value | Notes |
|---|---|---|
| `HEYREACH_API_KEY` | workspace-level rotated key | Original exposed key (`w2yOFmJp...`) is revoked |
| `HEYREACH_DEFAULT_CAMPAIGN_ID` | **`432819`** (OLD finished) | ⚠️ Should update to `432820` for clean logs. Not blocking — list-add path uses LIST_ID, not CAMPAIGN_ID |
| `HEYREACH_DEFAULT_LIST_ID` | `673244` | Bound to active campaign 432820 |
| `HEYREACH_DEFAULT_SENDER_ID` | `184100` | Victor Sandberg's LinkedIn account |
| `ANTHROPIC_API_KEY` | set, working | |
| `ENABLE_POLLER` | `false` | Keep off — webhooks are the production path |
| `AUTO_SEND_THRESHOLD` | unset (default `0.85`) | Recommend `2.0` for early ops → forces every reply to human review |
| `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID` | set | Required for lead persistence |

---

## HeyReach config

- **Active campaign:** 432820 "Test"
  - Status: `IN_PROGRESS`
  - Lead list: 673244
  - Sender: 184100
- **Sequence:**
  - Step 1: Send Connection Request (RECOMMENDED for cold leads)
  - Step 2: Send Message with body **`{{message}}`** (exact syntax — NOT `{{customField.message}}`)
- **Available custom fields in template:** `{{message}}`, `{{first_name}}`, `{{full_name}}`, `{{company}}`, `{{role}}`, `{{industry}}`, `{{location}}`, `{{seniority}}`
- **Seed lead:** at least 1 lead must be in the list before activation, else HeyReach auto-finishes campaign on empty

---

## Current leads in InFeed

| Name | URL | Status |
|---|---|---|
| Krisztina Toth | `linkedin.com/in/krisztina-toth-2a2bba1ab/` | Real prospect, queued in HeyReach campaign 432820 (pending dispatch) |
| Pipeline Probe | fake URL | My test lead — **safe to delete** |

HeyReach campaign 432820 has 3 totalUsers (seed + Pipeline Probe + Krisztina), 2 pending, 1 inProgress, 0 failed.

---

## What works (validated)

- ✅ Import endpoint accepts industry/location/seniority/about enrichment fields
- ✅ Asset matcher reads `notes.industry / notes.location / notes.seniority` (no more `MISSING RELEVANT JOB LIST` warning when fields are populated)
- ✅ Cold-opener flow pulls full matrix-cell training via `router.buildDraftGuidance` and feeds it to Claude
- ✅ HeyReach API integration: `list/AddLeadsToList` with `profileUrl` + `firstName/lastName/companyName` + `customUserFields[]`
- ✅ Delete-lead UI button (red, with confirm) in expanded lead row
- ✅ Mobile responsive dashboard with momentum scroll + tap-to-annotate
- ✅ Voice DNA loaded: 981 source records (137 corrections, 199 annotations, 223 thumbs-up, 218 thumbs-down, 62 drafts), DNA generated 2 days ago
- ✅ "What fed this?" breakdown now stored on import drafts (was only on simulation drafts)
- ✅ End-to-end LinkedIn delivery: Oliver Sandberg received cold opener 2026-05-15 (proved before template-syntax fix; he got literal `{{customField.message}}`)
- ✅ Conversations panel shows cold opener immediately on import (status='queued' until HeyReach dispatches; flips to 'sent' after thread sync)
- ✅ Auto reply: 60–120s delay before sending (was 2–8s — too bot-like)
- ✅ Synthetic `import-${leadId}` conv ID auto-merges into HeyReach real conv ID on first inbound or first sync (no more 2 conversations per lead)
- ✅ Thread sync endpoint `POST /conversations/:id/sync` + auto-sync on `GET /conversations/:id` (30s cache) pulls HeyReach-side activity (campaign step 2, manual LinkedIn sends, etc.) into the dashboard
- ✅ Dashboard: Sync button on conversation header + queued/sent status indicators on outbound message bubbles
- ✅ `.gitignore` added — node_modules, .DS_Store, .env, dashboard/build, data/ now excluded

---

## Open items (ranked by importance)

### High
- ☐ Update `HEYREACH_DEFAULT_CAMPAIGN_ID` from `432819` to `432820` on Railway (cosmetic but cleaner action logs)
- ☐ Validate the reply flow: have Krisztina (or another prospect) reply to her cold opener → confirm InFeed processes webhook → draft response appears in Conversations panel
- ☐ Verify HeyReach webhook is configured: HeyReach Settings → Webhooks → should POST to `https://infeed-marketing.up.railway.app/webhook/heyreach` with events including `MESSAGE_REPLY_RECEIVED`
- ☐ Train more matrix cells (currently strong on `analyst__cold_opener`, weaker on `associate__cold_opener`, `vp__cold_opener`, etc.)

### Medium
- ☐ Set `AUTO_SEND_THRESHOLD=2.0` on Railway for first week of live conversations (force human review)
- ☐ Add Airtable `id` column to Leads / Conversations / Actions tables if not done (else leads vanish on Railway restart)
- ☐ Clean up old test leads (Pipeline Probe, seed) from HeyReach to keep error counts honest
- ☐ Regenerate Voice DNA after a batch of new corrections lands (Voice DNA panel → Regenerate)

### Low / Future
- ☐ CSV bulk import UI for Sales Navigator exports (foundation built; UI deferred)
- ☐ Persistent asset storage: assets are stored in `workspaces/<id>/workspace.json` which is ephemeral on Railway. Mutations via dashboard vanish on redeploy. Either move to Airtable or commit workspace.json changes to git.
- ☐ Auto-follow-up cadence: when prospect doesn't reply within N days, InFeed scheduler should auto-draft follow-up and queue for review. Currently no automatic cadence — follow-ups are manual from the dashboard.
- ☐ InFeed scheduler follow-up step send: still uses old `heyreach.sendMessage` (broken). Either disable, or migrate to list-based send. Currently safe because user keeps all InFeed campaigns paused.
- ~~HeyReach delivery confirmation back to InFeed~~ → done via thread sync (poll-based, not webhook-based)
- ~~ConversationId mismatch (synthetic vs real)~~ → done via `mergeConversations` in store + auto-merge on first inbound

---

## Known gotchas

- **HeyReach silent reject (returns count=0)** common reasons:
  - LinkedIn profile URL doesn't actually exist
  - Lead already in HeyReach's account-wide dedup
  - Missing firstName/lastName/companyName in the lead payload
  - URL with non-ASCII chars (ą, é, etc.) may trip HeyReach's parser
- **HeyReach auto-finishes empty campaigns** within seconds of activation — always add a seed lead before launching
- **HeyReach "Send Message" step only works on 1st-degree connections** — add a "Send Connection Request" step before for 2nd/3rd
- **HeyReach template syntax** is `{{message}}` (variable name only), NOT `{{customField.message}}` or `{{customField:message}}`
- **Railway filesystem is ephemeral** — `workspaces/*/workspace.json` edits via dashboard vanish on redeploy
- **Voice DNA is aggregated** — corrections/annotations take effect IMMEDIATELY in next draft via `store.getTrainingPreferences()`, but DNA rule extraction is lazy (manual regen)
- **API key tier matters** — only `Workspace-level` HeyReach keys can call `list/AddLeadsToList`. Account-level keys 401 on it.

---

## Architecture — key files

### Backend
| File | What it does |
|---|---|
| `src/services/router.js` | Has `buildDraftGuidance` helper (exported) that pulls matrix-cell training. Used by both reply flow (`processInboundMessage`) and cold-opener import flow. |
| `src/services/store.js` | `upsertLead` accepts `notes` and `about`; `deleteLead` cascades to conversations + Airtable. |
| `src/services/heyreach.js` | `addLeadToList` (real endpoint `/list/AddLeadsToList`) with `profileUrl` + name fields + `customUserFields[]`. `addLeadToCampaign` is a backwards-compat wrapper. |
| `src/services/job-list-matcher.js` | 3-axis matcher (industry × geography × experience) with fallback chain reading from notes first. |
| `src/routes/leads.js` | `POST /import` extracts enrichment fields, calls `router.buildDraftGuidance`, queues to HeyReach list. `DELETE /:id` cascades. |

### Frontend
| File | What it does |
|---|---|
| `dashboard/src/App.js` | `LeadsPanel` has enrichment fields in import form + Delete button. `useIsMobile` hook + tap-to-annotate. |
| `dashboard/src/services/api.js` | `deleteLead` wrapper. |
| `dashboard/public/index.html` | Viewport-fit=cover, momentum scroll, mobile annotation popovers as bottom sheets. |

### Memory
- `~/.claude/projects/.../memory/MEMORY.md` — index of memory entries
- Memory entries describe project context, feedback rules, and references

---

## Daily operational flow (once Krisztina validates)

```
Morning:
  1. Source 5–10 prospects via Sales Nav / LinkedIn search
  2. InFeed → Leads → + Import each (cold opener ON)
  3. HeyReach queues them and dispatches over the day

Afternoon:
  4. Check Conversations panel for any replies
  5. For each Claude-drafted reply: rate (+/−), edit, or approve+send
  6. Highlight phrases you don't like → annotate BAD → trains for next time
  7. Rewrite drafts that miss the mark → saved as corrections

Evening:
  8. Spot-check HeyReach: any Lead Error / Lead removed? Adjust URLs / dedup
  9. Voice DNA regeneration (Voice DNA panel → Regenerate if many new corrections)
```

Scale: start at 5/day. After 1 week of corrections, ramp to 10. After 2 weeks, 20–30 (HeyReach daily limit per sender).

---

## Recent commit on GitHub

Last meaningful commit: 2026-05-16 07:22 UTC — "Feed matrix-cell training into cold-opener drafts" (router.js with `buildDraftGuidance` + leads.js wiring it in).

Prior major commits today (2026-05-16):
- HeyReach endpoint correction: `/campaign/AddLeads` → `/list/AddLeadsToList` with `profileUrl` field name
- HeyReach error surfacing in /import response
- Pass firstName/lastName/companyName to HeyReach to avoid silent reject
- Delete-lead backend (store.js + routes/leads.js) and UI (App.js)
- Dashboard mobile responsive + tap-to-annotate
- Lead import enrichment fields (industry, location, seniority, about)

---

## If you're resuming a session

1. Read this file
2. Check `~/.claude/projects/.../memory/MEMORY.md` for any new memory entries
3. Probe current state with:
   - `curl https://infeed-marketing.up.railway.app/health`
   - `curl https://infeed-marketing.up.railway.app/api/leads`
   - `curl "https://infeed-marketing.up.railway.app/api/analytics/heyreach"` for HeyReach campaign visibility
4. Compare to "Open items" section above — pick up from highest-priority unchecked item
