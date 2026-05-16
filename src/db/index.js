// src/db/index.js
// Postgres connection pool + schema bootstrap. Replaces the prior Airtable
// dependency. Reads DATABASE_URL from env (Supabase/Railway/Neon all work the
// same — standard Postgres URI).
//
// Usage:
//   const { query, initSchema, isConfigured } = require('./db');
//   await initSchema();
//   const { rows } = await query('SELECT * FROM leads WHERE workspace_id = $1', ['infeed']);

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  // Supabase, Neon, and Railway Postgres all require SSL on hosted connections.
  // `rejectUnauthorized: false` is required for Supabase's pooler endpoint
  // which uses a cert chain not present in Node's default CA bundle.
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    console.error('[DB] Idle client error:', err.message);
  });

  return pool;
}

function isConfigured() {
  return !!process.env.DATABASE_URL;
}

async function query(text, params = []) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL not set — Postgres not configured');
  return p.query(text, params);
}

// Apply schema.sql idempotently. Safe to call on every startup — every
// statement uses IF NOT EXISTS. Returns true if schema applied, false if DB
// not configured.
async function initSchema() {
  if (!isConfigured()) {
    console.warn('[DB] DATABASE_URL not set — skipping schema init. Data will NOT persist across restarts.');
    return false;
  }
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    await query(schema);
    console.log('[DB] Schema applied (all tables ensured)');
    return true;
  } catch (err) {
    console.error('[DB] Schema init failed:', err.message);
    throw err;
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, initSchema, isConfigured, close };
