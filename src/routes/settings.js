// src/routes/settings.js
// Settings API — backs the dashboard's Settings panel.

const express = require('express');
const router = express.Router();
const settings = require('../services/settings');
const store    = require('../services/store');

// GET /api/settings — current status. Never returns the actual API key value;
// returns hasAirtableKey + a masked preview so the user can confirm what's
// stored without exposing the secret in transit.
router.get('/', (req, res) => {
  res.json(settings.getStatus());
});

// POST /api/settings/airtable — update Airtable credentials.
// Body: { apiKey?: string, baseId?: string }
//   - empty string clears the value
//   - undefined leaves it unchanged
// After saving, hot-updates process.env, resets the cached Airtable client,
// and runs a force-resync of any pending records (so as soon as you paste a
// valid key, anything that was sitting in the local backup gets pushed up).
router.post('/airtable', async (req, res) => {
  const { apiKey, baseId } = req.body || {};
  const current = settings.loadSettings();
  if (apiKey !== undefined) current.AIRTABLE_API_KEY = apiKey || '';
  if (baseId !== undefined) current.AIRTABLE_BASE_ID = (baseId || '').split('/')[0];
  settings.saveSettings(current);

  // Update env immediately
  if (apiKey !== undefined) settings.updateEnv('AIRTABLE_API_KEY', current.AIRTABLE_API_KEY);
  if (baseId !== undefined) settings.updateEnv('AIRTABLE_BASE_ID', current.AIRTABLE_BASE_ID);

  // Invalidate the cached Airtable client so the next call rebuilds with new creds
  if (typeof store.resetAirtableClient === 'function') store.resetAirtableClient();

  // Try a force-resync now to push anything that's been waiting locally.
  // Don't fail the response if this errors — settings are already saved.
  let resync = null;
  try {
    if (process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID) {
      resync = await store.forceResyncTrainingToAirtable();
    }
  } catch (err) {
    console.warn('[Settings] Auto-resync after credential update failed:', err.message);
  }

  console.log(`[Settings] Airtable credentials updated. Key: ${process.env.AIRTABLE_API_KEY ? 'set' : 'cleared'}, Base: ${process.env.AIRTABLE_BASE_ID || 'cleared'}${resync ? ` — pushed ${resync.pushed}/${resync.totalPending} pending records` : ''}`);

  res.json({
    success: true,
    status: settings.getStatus(),
    resync,
  });
});

// POST /api/settings/test-airtable — verify the current credentials actually
// work, by trying to read one record from the Training table. Useful immediately
// after a credential update so the user knows the key is valid.
router.post('/test-airtable', async (req, res) => {
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    return res.status(400).json({ ok: false, error: 'No credentials set' });
  }
  try {
    // Re-import Airtable on the fly to test the current creds
    const Airtable = require('airtable');
    const baseId = (process.env.AIRTABLE_BASE_ID || '').split('/')[0];
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(baseId);
    const tableName = process.env.AIRTABLE_TRAINING_TABLE || 'Training';
    await base(tableName).select({ maxRecords: 1 }).firstPage();
    res.json({ ok: true, message: `Connected to base ${baseId}, table ${tableName}` });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
