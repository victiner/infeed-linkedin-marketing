// src/services/workspace.js
// Workspace loader — loads business-specific configurations that drive all prompts, assets, and training.
// Each workspace is a folder under /workspaces/<id>/ containing workspace.json.
//
// Two levels of workspace selection:
// 1. GLOBAL active workspace — what the dashboard UI shows. Set via env or /api/workspace/switch.
// 2. REQUEST-SCOPED workspace — used by webhooks/pollers/schedulers to process data for a specific
//    business regardless of what the UI is currently showing. Implemented via AsyncLocalStorage.

const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

const WORKSPACES_DIR = path.join(__dirname, '..', '..', 'workspaces');

// Cache of loaded workspace configs — avoids re-reading from disk on every request
const workspaceCache = new Map(); // id -> workspace object

let activeWorkspace = null;
let activeWorkspaceId = null;

// Per-async-request workspace context — set by runInContext(), read by get()/getId()
const asyncStore = new AsyncLocalStorage();

// Low-level: read a workspace from disk (bypasses cache). Throws on error.
function readFromDisk(id) {
  const wsPath = path.join(WORKSPACES_DIR, id, 'workspace.json');
  if (!fs.existsSync(wsPath)) {
    throw new Error(`Workspace not found: ${wsPath}`);
  }
  const raw = fs.readFileSync(wsPath, 'utf-8');
  const ws = JSON.parse(raw);

  const required = ['company', 'audiences', 'services', 'plans', 'industries', 'avatars', 'assets', 'messaging'];
  const missing = required.filter(k => !ws[k]);
  if (missing.length) {
    throw new Error(`Workspace "${id}" is missing required fields: ${missing.join(', ')}`);
  }
  return ws;
}

// Load a workspace into cache. Called once per workspace at first use.
function loadAndCache(id) {
  if (workspaceCache.has(id)) return workspaceCache.get(id);
  const ws = readFromDisk(id);
  workspaceCache.set(id, ws);
  return ws;
}

// Set the globally-active workspace (what the dashboard UI sees by default).
function load(workspaceId) {
  const id = workspaceId || process.env.WORKSPACE_ID || 'infeed';
  activeWorkspace = loadAndCache(id);
  activeWorkspaceId = id;
  console.log(`[Workspace] Active: "${activeWorkspace.company.name}" (${id})`);
  return activeWorkspace;
}

// Reload from disk (clears cache for that workspace)
function reload(workspaceId) {
  const id = workspaceId || activeWorkspaceId;
  workspaceCache.delete(id);
  return loadAndCache(id);
}

// Run a function within a specific workspace's context. All calls to get()/getId()
// inside `fn` (even across awaits) will return the specified workspace, without
// affecting the globally-active one. Used by webhooks, pollers, schedulers.
function runInContext(workspaceId, fn) {
  const ws = loadAndCache(workspaceId);
  return asyncStore.run({ id: workspaceId, ws }, fn);
}

// Find which workspace owns a given HeyReach senderId by scanning all workspace configs.
// Returns the workspace ID, or null if no match.
function findBySenderId(senderId) {
  if (!senderId) return null;
  const all = list();
  for (const entry of all) {
    try {
      const ws = loadAndCache(entry.id);
      if (Array.isArray(ws.senders) && ws.senders.includes(senderId)) {
        return entry.id;
      }
    } catch {}
  }
  return null;
}

// List all available workspaces by scanning the workspaces directory
function list() {
  if (!fs.existsSync(WORKSPACES_DIR)) return [];
  return fs.readdirSync(WORKSPACES_DIR)
    .filter(name => !name.startsWith('_') && !name.startsWith('.'))
    .map(id => {
      const wsPath = path.join(WORKSPACES_DIR, id, 'workspace.json');
      if (!fs.existsSync(wsPath)) return null;
      try {
        const raw = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
        return {
          id,
          name: raw.company?.name || id,
          tagline: raw.company?.tagline || '',
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Switch the globally-active workspace at runtime. Does NOT affect async contexts.
function switchTo(workspaceId) {
  // Force reload from disk in case workspace.json was edited
  workspaceCache.delete(workspaceId);
  return load(workspaceId);
}

function get() {
  // If we're inside a runInContext() call, return that workspace; otherwise the global active one.
  const ctx = asyncStore.getStore();
  if (ctx && ctx.ws) return ctx.ws;
  if (!activeWorkspace) throw new Error('Workspace not loaded. Call workspace.load() first.');
  return activeWorkspace;
}

function getId() {
  const ctx = asyncStore.getStore();
  if (ctx && ctx.id) return ctx.id;
  return activeWorkspaceId;
}

// ---- DERIVED HELPERS ----
// These compute values from the workspace config so callers don't have to repeat logic.

function getCompany() {
  return get().company;
}

function getPlans() {
  return get().plans;
}

function getPlanDetails() {
  const plans = getPlans();
  const details = {};
  for (const p of plans) {
    const key = p.name.toLowerCase().replace(/\s+/g, '_');
    details[key] = `${p.name} — ${p.price}. ${p.includes}`;
  }
  return details;
}

function getDefaultPlan() {
  const plans = getPlans();
  const def = plans.find(p => p.default);
  return def ? def.name.toLowerCase().replace(/\s+/g, '_') : plans[0]?.name.toLowerCase().replace(/\s+/g, '_');
}

function getAvatars() {
  return get().avatars;
}

function getAvatarBySeniority(seniority) {
  return getAvatars().find(a =>
    Array.isArray(a.seniority) ? a.seniority.includes(seniority) : a.seniority === seniority
  ) || null;
}

function getAssets() {
  return get().assets;
}

function getIndustryKeywords() {
  return get().industry_keywords || {};
}

function getSeniorityLevels() {
  return get().seniority_levels || [];
}

function getMessaging() {
  return get().messaging;
}

function getAvatarAxes() {
  return get().avatar_axes || {
    seniority: ['student', 'intern', 'analyst', 'associate', 'vp_director', 'senior_exec'],
    stage:     ['cold_opener', 'natural_response', 'value_pitch', 'close', 'follow_up'],
    situation: ['neutral', 'curious', 'price_objection', 'time_objection',
                'confidentiality_objection', 'has_alternative', 'buying_signal', 'frustrated',
                'follow_up_after_ghosting', 'wants_intro_to_specific_firm'],
  };
}

// Horizon-expansion adjacency graphs. Editable via dashboard. Defaults below
// kick in only if workspace.json doesn't define horizon_axes (fresh workspace).
function getHorizonAxes() {
  const ws = get();
  if (ws.horizon_axes) return ws.horizon_axes;
  return {
    experience: {
      student: ['intern', 'analyst'], intern: ['analyst'],
      analyst: ['associate'], associate: ['vp_director'],
      vp_director: ['senior_exec'], senior_exec: [],
    },
    industry: {
      investment_banking: ['private_equity', 'asset_management'],
      private_equity:     ['investment_banking', 'venture_capital'],
      asset_management:   ['investment_banking', 'private_equity'],
    },
    geography: {
      frankfurt: ['munich'], munich: ['frankfurt'],
      london: ['frankfurt', 'paris'], paris: ['london'],
    },
  };
}

function getPricingRules() {
  return get().pricing_rules || {};
}

module.exports = {
  load,
  list,
  switchTo,
  reload,
  runInContext,
  findBySenderId,
  get,
  getId,
  getCompany,
  getPlans,
  getPlanDetails,
  getDefaultPlan,
  getAvatars,
  getAvatarBySeniority,
  getAssets,
  getIndustryKeywords,
  getSeniorityLevels,
  getMessaging,
  getAvatarAxes,
  getHorizonAxes,
  getPricingRules,
};
