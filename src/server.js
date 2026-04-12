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
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
    heyreachConfigured: !!process.env.HEYREACH_API_KEY
  });
});

// ---- ROUTES ----
app.use('/webhook', webhookRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/playbook', playbookRouter);
app.use('/api/campaigns', campaignsRouter);

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

  // Load persisted data from Airtable
  await store.init();

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
