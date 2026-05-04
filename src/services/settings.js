// src/services/settings.js
// Runtime settings store — backs the dashboard's Settings panel.
//
// Lets the user enter credentials (Airtable API key, base id, etc.) once via
// the UI instead of editing .env. Stored in a per-machine JSON file so each
// laptop can have its own creds without affecting the shared repo.
//
// Resolution order (highest priority first):
//   1. Runtime settings file (data/runtime-settings.json) — set via dashboard
//   2. Process env (.env) — same as before
//
// On startup, the server calls applyToEnv() which copies file values into
// process.env if they aren't already set there. The settings POST route
// updates env at runtime + resets the Airtable client so changes take effect
// without a restart.

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', '..', 'data', 'runtime-settings.json');

// Whitelist of keys we allow the dashboard to set. Adding more is safe —
// just be sure they're meant to be exposed via the UI (don't put secrets that
// shouldn't be reset by anyone with dashboard access here).
const ALLOWED_KEYS = new Set([
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
  'AIRTABLE_LEADS_TABLE',
  'AIRTABLE_CONVERSATIONS_TABLE',
  'AIRTABLE_ACTIONS_TABLE',
  'AIRTABLE_TRAINING_TABLE',
  'AIRTABLE_RATINGS_TABLE',
]);

function ensureDir() {
  try { fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true }); } catch {}
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    // Filter to whitelist — defensive, in case the file got hand-edited
    const filtered = {};
    for (const [k, v] of Object.entries(raw)) {
      if (ALLOWED_KEYS.has(k) && v) filtered[k] = String(v);
    }
    return filtered;
  } catch (err) {
    console.warn('[Settings] Failed to load:', err.message);
    return {};
  }
}

function saveSettings(settings) {
  ensureDir();
  const filtered = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (ALLOWED_KEYS.has(k) && v) filtered[k] = String(v);
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(filtered, null, 2));
  return filtered;
}

// Copy file settings into process.env, but only for keys that aren't already
// set there. .env wins over runtime settings — this is intentional, so a
// production deploy with proper env vars never gets overridden by a stale
// runtime-settings.json that happened to be on disk.
function applyToEnv(settings) {
  for (const [key, value] of Object.entries(settings)) {
    if (value && !process.env[key]) {
      process.env[key] = String(value);
    }
  }
}

// Hot-update a single env var. Used after the dashboard saves new settings —
// we always override here, since the user is explicitly choosing a new value.
function updateEnv(key, value) {
  if (!ALLOWED_KEYS.has(key)) return;
  if (value) process.env[key] = String(value);
  else delete process.env[key];
}

// Public status — never returns the actual API key value, only whether one
// is set, plus a masked preview for confirmation.
function getStatus() {
  const file = loadSettings();
  const effectiveKey  = process.env.AIRTABLE_API_KEY || file.AIRTABLE_API_KEY || null;
  const effectiveBase = process.env.AIRTABLE_BASE_ID || file.AIRTABLE_BASE_ID || null;
  return {
    hasAirtableKey:    !!effectiveKey,
    airtableKeyMasked: effectiveKey ? `${effectiveKey.slice(0, 6)}…${effectiveKey.slice(-4)}` : null,
    airtableKeySource: process.env.AIRTABLE_API_KEY && !file.AIRTABLE_API_KEY
                       ? 'env' : (file.AIRTABLE_API_KEY ? 'settings_file' : null),
    airtableBaseId:    effectiveBase,
    airtableBaseSource: process.env.AIRTABLE_BASE_ID && !file.AIRTABLE_BASE_ID
                        ? 'env' : (file.AIRTABLE_BASE_ID ? 'settings_file' : null),
  };
}

module.exports = {
  loadSettings,
  saveSettings,
  applyToEnv,
  updateEnv,
  getStatus,
  ALLOWED_KEYS,
  SETTINGS_PATH,
};
