// src/routes/avatars.js
// Avatar matrix API — coverage view, per-avatar example browser, manual canonical toggle, migration trigger.

const express = require('express');
const router = express.Router();

const avatars   = require('../services/avatars');
const migrate   = require('../services/avatars-migrate');
const workspace = require('../services/workspace');
const store     = require('../services/store');

// GET /api/avatars/axes — returns the configured axes (seniority/stage/situation values)
router.get('/axes', (req, res) => {
  res.json({ workspace: workspace.getId(), axes: avatars.axes(), all: avatars.listAllAvatars() });
});

// GET /api/avatars/coverage — full matrix with example counts per cell
router.get('/coverage', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  res.json({ workspace: wsId, ...avatars.getCoverage(wsId) });
});

// GET /api/avatars/:avatarId/examples — list every USEFUL example tagged to this avatar
//   ?injected=true → also returns the exact 3+3 currently sent to Claude as the canonical block
router.get('/:avatarId/examples', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  const examples = avatars.getAvatarExamples(wsId, req.params.avatarId);
  const payload = { workspace: wsId, avatarId: req.params.avatarId, examples };
  if (req.query.injected === 'true' || req.query.injected === '1') {
    payload.injected = avatars.getInjectedExamples(wsId, req.params.avatarId, { limit: 3 });
  }
  res.json(payload);
});

// DELETE /api/avatars/example/:airtableId — remove a wrong/stale training record entirely
router.delete('/example/:airtableId', async (req, res) => {
  try {
    const removed = await store.deleteTrainingPreference(req.params.airtableId);
    res.json({ success: true, removed: !!removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/avatars/example/:airtableId — edit fields on a training record.
//   Body can include: isCanonical, avatar, chosen, original, feedback, selectedText, rating
router.patch('/example/:airtableId', async (req, res) => {
  try {
    const allowed = ['isCanonical', 'avatar', 'chosen', 'original', 'feedback', 'selectedText', 'rating', 'question'];
    const fields = {};
    for (const k of allowed) if (k in (req.body || {})) fields[k] = req.body[k];
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No editable fields provided' });
    const result = await store.updateTrainingFields(req.params.airtableId, fields);
    res.json({ success: true, record: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/avatars/:avatarId/examples — create a new training example DIRECTLY for an avatar.
// Body: { type: 'thumbs_up'|'thumbs_down'|'correction'|'draft', chosen, original?, feedback?, isCanonical? }
// This lets the user train a specific avatar without going through the AI Training simulation panel.
router.post('/:avatarId/examples', async (req, res) => {
  try {
    const wsId = req.query.workspace || workspace.getId();
    const avatarId = req.params.avatarId;
    if (!avatars.parseAvatarId(avatarId)) return res.status(400).json({ error: `Invalid avatar id: ${avatarId}` });
    const { type, chosen, original = '', feedback = '', question = '', isCanonical = false } = req.body || {};
    const allowedTypes = new Set(['thumbs_up', 'thumbs_down', 'correction', 'draft', 'qa']);
    if (!allowedTypes.has(type)) return res.status(400).json({ error: `type must be one of: ${[...allowedTypes].join(', ')}` });
    if (!chosen || !chosen.trim()) return res.status(400).json({ error: '"chosen" is required and cannot be empty' });
    if (type === 'correction' && !original) return res.status(400).json({ error: 'corrections require an "original" (BAD) version' });
    if (type === 'qa' && (!question || !question.trim())) return res.status(400).json({ error: 'Q&A entries require a "question" (the lead\'s question)' });

    const parsed = avatars.parseAvatarId(avatarId);
    const pref = {
      type,
      scenario: { seniority: parsed.seniority, funnelStage: parsed.stage, situation: parsed.situation },
      chosen,
      original,
      feedback,
      selectedText: '',
      rating: type === 'thumbs_down' ? 'bad' : 'good',
      thread: [],
      question,
      optionIndex: -1,
      isCustom: true,
      avatar: avatarId,
      isCanonical: !!isCanonical,
      timestamp: new Date().toISOString(),
      source: 'manual',
      workspaceId: wsId,
    };
    // Await so the response includes the real airtableId — the dashboard needs it
    // to immediately edit/delete/star the just-added record without waiting for refresh.
    await store.addTrainingPreference(pref);
    // airtableSynced=false means addTrainingPreference's Airtable create silently
    // failed (rate limit / network blip). The example exists in memory but
    // edit/delete/star against this row will 400 until sync recovers — the
    // dashboard surfaces a warning when this flag is false.
    res.json({ success: true, record: pref, airtableSynced: !!pref.airtableId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/avatars/axes/situation — add a new situation column to the matrix.
// Body: { name: 'wants_specific_role_type' }  — slug-style, lowercase, underscores only.
router.post('/axes/situation', (req, res) => {
  try {
    const raw = (req.body && req.body.name) || '';
    const name = String(raw).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!name) return res.status(400).json({ error: 'Provide a "name" (will be slugified to lowercase + underscores)' });
    const wsId = workspace.getId();
    const wsPath = require('path').join(__dirname, '..', '..', 'workspaces', wsId, 'workspace.json');
    const fs = require('fs');
    const ws = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
    ws.avatar_axes = ws.avatar_axes || { seniority: [], stage: [], situation: [] };
    ws.avatar_axes.situation = ws.avatar_axes.situation || [];
    if (ws.avatar_axes.situation.includes(name)) return res.status(409).json({ error: `Situation "${name}" already exists` });
    ws.avatar_axes.situation.push(name);
    fs.writeFileSync(wsPath, JSON.stringify(ws, null, 2));
    workspace.reload(wsId);
    res.json({ success: true, name, situations: ws.avatar_axes.situation });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/avatars/axes/situation/:name — remove a situation column.
// Will refuse if any training records are tagged into that column (safety).
router.delete('/axes/situation/:name', (req, res) => {
  try {
    const name = req.params.name;
    const wsId = workspace.getId();

    // Safety: refuse if any tagged records exist with this situation
    const records = store.getTrainingPreferences(wsId);
    const inUse = records.filter(p => {
      const ax = avatars.parseAvatarId(p.avatar || '');
      return ax && ax.situation === name;
    });
    if (inUse.length > 0 && !req.query.force) {
      return res.status(409).json({
        error: `${inUse.length} training records are tagged with "${name}". Move or delete them first, or pass ?force=true.`,
        count: inUse.length,
      });
    }

    const wsPath = require('path').join(__dirname, '..', '..', 'workspaces', wsId, 'workspace.json');
    const fs = require('fs');
    const ws = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
    ws.avatar_axes = ws.avatar_axes || { situation: [] };
    ws.avatar_axes.situation = (ws.avatar_axes.situation || []).filter(s => s !== name);
    fs.writeFileSync(wsPath, JSON.stringify(ws, null, 2));
    workspace.reload(wsId);
    res.json({ success: true, situations: ws.avatar_axes.situation, displaced: inUse.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/avatars/migrate — kick off batch classification of untagged records.
//   Body: { reclassify?: boolean } — if true, re-tag everything (ignore existing Avatar values)
router.post('/migrate', (req, res) => {
  const wsId = (req.body && req.body.workspace) || req.query.workspace || workspace.getId();
  const reclassify = !!(req.body && req.body.reclassify);
  const result = migrate.runMigration(wsId, { reclassify });
  if (result.error) return res.status(409).json(result);
  res.json({ workspace: wsId, ...result });
});

// GET /api/avatars/migrate/status — progress of an in-flight migration (or last run)
router.get('/migrate/status', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  res.json({ workspace: wsId, status: migrate.getStatus(wsId) });
});

module.exports = router;
