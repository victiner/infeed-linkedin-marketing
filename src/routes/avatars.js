// src/routes/avatars.js
// Avatar matrix API — coverage view, per-avatar example browser, manual canonical toggle, migration trigger.

const express = require('express');
const router = express.Router();

const avatars   = require('../services/avatars');
const migrate   = require('../services/avatars-migrate');
const workspace = require('../services/workspace');

// GET /api/avatars/axes — returns the configured axes (seniority/stage/situation values)
router.get('/axes', (req, res) => {
  res.json({ workspace: workspace.getId(), axes: avatars.axes(), all: avatars.listAllAvatars() });
});

// GET /api/avatars/coverage — full matrix with example counts per cell
router.get('/coverage', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  res.json({ workspace: wsId, ...avatars.getCoverage(wsId) });
});

// GET /api/avatars/:avatarId/examples — list every example tagged to this avatar
router.get('/:avatarId/examples', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  const examples = avatars.getAvatarExamples(wsId, req.params.avatarId);
  res.json({ workspace: wsId, avatarId: req.params.avatarId, examples });
});

// PATCH /api/avatars/example/:airtableId — set IsCanonical or change Avatar tag
router.patch('/example/:airtableId', async (req, res) => {
  try {
    const { isCanonical, avatar } = req.body || {};
    const updates = [];
    if (typeof isCanonical === 'boolean') updates.push(avatars.setExampleCanonical(req.params.airtableId, isCanonical));
    if (typeof avatar === 'string')       updates.push(avatars.setExampleAvatar(req.params.airtableId, avatar));
    await Promise.all(updates);
    res.json({ success: true });
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
