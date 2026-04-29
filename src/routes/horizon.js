// src/routes/horizon.js
// Horizon-expansion adjacency editor. Persists to workspace.json so changes survive restarts.

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const horizon = require('../services/horizon');
const workspace = require('../services/workspace');

const VALID_AXES = new Set(['experience', 'industry', 'geography']);

function workspacePath(id) {
  return path.join(__dirname, '..', '..', 'workspaces', id, 'workspace.json');
}

function readWs() {
  const id = workspace.getId();
  const p = workspacePath(id);
  if (!fs.existsSync(p)) throw new Error(`Workspace file not found: ${p}`);
  return { id, p, ws: JSON.parse(fs.readFileSync(p, 'utf-8')) };
}

function writeWs(id, ws) {
  fs.writeFileSync(workspacePath(id), JSON.stringify(ws, null, 2));
  workspace.reload(id);
}

function ensureHorizon(ws) {
  ws.horizon_axes = ws.horizon_axes || { experience: {}, industry: {}, geography: {} };
  for (const ax of VALID_AXES) ws.horizon_axes[ax] = ws.horizon_axes[ax] || {};
  return ws.horizon_axes;
}

// GET /api/horizon — full adjacency state for all 3 axes
router.get('/', (req, res) => {
  res.json({ workspace: workspace.getId(), axes: horizon.axes() });
});

// PUT /api/horizon/:axis — replace all entries for one axis
//   Body: { entries: { key1: ['neighbor1', 'neighbor2'], ... } }
router.put('/:axis', (req, res) => {
  try {
    const { axis } = req.params;
    if (!VALID_AXES.has(axis)) return res.status(400).json({ error: `axis must be one of: ${[...VALID_AXES].join(', ')}` });
    const entries = req.body && req.body.entries;
    if (!entries || typeof entries !== 'object') return res.status(400).json({ error: 'Body { entries: {...} } required' });
    const { id, ws } = readWs();
    const h = ensureHorizon(ws);
    // Normalize keys + values to lowercase + underscores
    const norm = (s) => String(s).trim().toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    const cleaned = {};
    for (const [k, vs] of Object.entries(entries)) {
      const nk = norm(k);
      if (!nk) continue;
      cleaned[nk] = Array.isArray(vs) ? [...new Set(vs.map(norm).filter(Boolean).filter(v => v !== nk))] : [];
    }
    h[axis] = cleaned;
    writeWs(id, ws);
    res.json({ success: true, axis, entries: cleaned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/horizon/:axis/:key — add a new key (with optional initial neighbors)
//   Body: { neighbors?: [...] }
router.post('/:axis/:key', (req, res) => {
  try {
    const { axis, key } = req.params;
    if (!VALID_AXES.has(axis)) return res.status(400).json({ error: `Invalid axis` });
    const norm = (s) => String(s).trim().toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    const nkey = norm(key);
    if (!nkey) return res.status(400).json({ error: 'Invalid key' });
    const { id, ws } = readWs();
    const h = ensureHorizon(ws);
    if (h[axis][nkey]) return res.status(409).json({ error: `Key "${nkey}" already exists in ${axis}` });
    const initial = Array.isArray(req.body?.neighbors) ? req.body.neighbors.map(norm).filter(Boolean).filter(v => v !== nkey) : [];
    h[axis][nkey] = [...new Set(initial)];
    writeWs(id, ws);
    res.json({ success: true, axis, key: nkey, neighbors: h[axis][nkey] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/horizon/:axis/:key — remove a key entirely
router.delete('/:axis/:key', (req, res) => {
  try {
    const { axis, key } = req.params;
    if (!VALID_AXES.has(axis)) return res.status(400).json({ error: 'Invalid axis' });
    const { id, ws } = readWs();
    const h = ensureHorizon(ws);
    delete h[axis][key];
    writeWs(id, ws);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
