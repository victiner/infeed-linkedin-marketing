// src/server.js
// Main Express server

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const webhookRouter = require('./routes/webhook');
const conversationsRouter = require('./routes/conversations');
const leadsRouter = require('./routes/leads');
const { assetsRouter, analyticsRouter, playbookRouter, campaignsRouter } = require('./routes/leads');
const { serveDashboard } = require('./middleware/dashboard');
const store = require('./services/store');
const workspace = require('./services/workspace');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ---- MIDDLEWARE ----
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Too many requests' }
});
app.use('/api', limiter);

// ---- HEALTH CHECK ----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'linkedin-nurture-system',
    version: '2.0.0',
    workspace: workspace.getId(),
    company: workspace.getCompany().name,
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
    heyreachConfigured: !!process.env.HEYREACH_API_KEY
  });
});

// ---- WORKSPACE INFO ----
app.get('/api/workspace', (req, res) => {
  const ws = workspace.get();
  res.json({
    id: workspace.getId(),
    company: ws.company,
    industries: ws.industries,
    plans: ws.plans,
    avatars: ws.avatars.map(a => ({ id: a.id, name: a.name, seniority: a.seniority, tone: a.tone })),
  });
});

// List all available workspaces (for the dashboard switcher)
app.get('/api/workspaces', (req, res) => {
  res.json({
    active: workspace.getId(),
    workspaces: workspace.list(),
  });
});

// Switch the active workspace
app.post('/api/workspace/switch', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const ws = workspace.switchTo(id);
    console.log(`[Server] Workspace switched to: ${ws.company.name} (${id})`);
    res.json({
      success: true,
      active: workspace.getId(),
      company: ws.company,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- SENDER MANAGEMENT ----
// Each workspace has a `senders` array of HeyReach linkedInAccountId values.
// Inbound webhooks get routed to the correct workspace based on this mapping.

const path = require('path');
const fs = require('fs');

function workspacePath(id) {
  return path.join(__dirname, '..', 'workspaces', id, 'workspace.json');
}

function readWorkspaceFile(id) {
  const p = workspacePath(id);
  if (!fs.existsSync(p)) throw new Error(`Workspace "${id}" not found`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeWorkspaceFile(id, data) {
  fs.writeFileSync(workspacePath(id), JSON.stringify(data, null, 2));
  workspace.reload(id); // re-cache with fresh data
}

// List senders for the active workspace
app.get('/api/senders', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  try {
    const ws = readWorkspaceFile(wsId);
    res.json({ workspace: wsId, senders: ws.senders || [] });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Add a sender to a workspace
app.post('/api/senders', (req, res) => {
  const { senderId, workspaceId } = req.body || {};
  const wsId = workspaceId || workspace.getId();
  if (!senderId) return res.status(400).json({ error: 'senderId required' });

  try {
    // Check no other workspace already claims this sender
    const existingWs = workspace.findBySenderId(senderId);
    if (existingWs && existingWs !== wsId) {
      return res.status(409).json({ error: `Sender already assigned to workspace "${existingWs}"` });
    }

    const ws = readWorkspaceFile(wsId);
    ws.senders = ws.senders || [];
    if (!ws.senders.includes(senderId)) {
      ws.senders.push(senderId);
      writeWorkspaceFile(wsId, ws);
    }
    res.json({ success: true, workspace: wsId, senders: ws.senders });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove a sender from a workspace
app.delete('/api/senders/:senderId', (req, res) => {
  const { senderId } = req.params;
  const wsId = req.query.workspace || workspace.getId();
  try {
    const ws = readWorkspaceFile(wsId);
    ws.senders = (ws.senders || []).filter(s => s !== senderId);
    writeWorkspaceFile(wsId, ws);
    res.json({ success: true, workspace: wsId, senders: ws.senders });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- ROUTES ----
app.use('/webhook', webhookRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/playbook', playbookRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/training', require('./routes/training'));

// ---- DASHBOARD (serves built React app) ----
serveDashboard(app);

// ---- ERROR HANDLER ----
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ---- STARTUP ----
async function start() {
  // Validate required env vars
  const required = ['ANTHROPIC_API_KEY', 'HEYREACH_API_KEY', 'WEBHOOK_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[Server] Missing required environment variables: ${missing.join(', ')}`);
    console.error('[Server] Copy .env.example to .env and fill in your values');
    process.exit(1);
  }

  // Load workspace config (must happen before anything that reads prompts/assets)
  const ws = workspace.load(process.env.WORKSPACE_ID);
  console.log(`[Server] Workspace: ${ws.company.name}`);

  // Load persisted data from Airtable
  await store.init();
  await store.loadTraining();

  // Optional: verify HeyReach connection on startup
  try {
    const heyreach = require('./services/heyreach');
    const ok = await heyreach.checkApiKey();
    console.log(`[Server] HeyReach API: ${ok ? '✓ connected' : '✗ check your API key'}`);
  } catch (err) {
    console.warn('[Server] HeyReach API check failed:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`\n[Server] LinkedIn Nurture System running on port ${PORT}`);
    console.log(`[Server] Health: http://localhost:${PORT}/health`);
    console.log(`[Server] Webhook: http://localhost:${PORT}/webhook/heyreach`);
    console.log(`[Server] API: http://localhost:${PORT}/api/\n`);

    // Start inbox poller (if ENABLE_POLLER=true)
    const poller = require('./services/poller');
    poller.start();

    // Start campaign step scheduler (always runs)
    const scheduler = require('./services/scheduler');
    scheduler.start();
  });
}

start();

module.exports = app;
