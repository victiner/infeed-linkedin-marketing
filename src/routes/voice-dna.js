// src/routes/voice-dna.js
// Voice DNA API — read current rules, status, and trigger regeneration.

const express = require('express');
const router = express.Router();

const voiceDna = require('../services/voice-dna');
const workspace = require('../services/workspace');
const { buildSystemPrompt } = require('../prompts/routing');

// GET /api/voice-dna — current voice DNA + status for the active (or ?workspace=) workspace
router.get('/', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  const dna = voiceDna.getCurrent(wsId);
  const status = voiceDna.getStatus(wsId);
  res.json({ workspace: wsId, dna, status });
});

// GET /api/voice-dna/status — lightweight status only (for dashboard polling/badge)
router.get('/status', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  res.json({ workspace: wsId, status: voiceDna.getStatus(wsId) });
});

// GET /api/voice-dna/history — returns recent voice DNA snapshots (newest first) for the workspace.
//   ?limit=N (default 5, max MAX_HISTORY in service)
router.get('/history', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  const limit = parseInt(req.query.limit, 10) || 5;
  res.json({ workspace: wsId, history: voiceDna.getHistory(wsId, limit) });
});

// GET /api/voice-dna/preview-prompt — returns the EXACT system prompt currently sent to Claude.
// Use this to verify your voice DNA is being injected: search the response for "=== YOUR VOICE DNA".
router.get('/preview-prompt', (req, res) => {
  const wsId = req.query.workspace || workspace.getId();
  const dna = voiceDna.getCurrent(wsId);
  let systemPrompt = '';
  let buildError = null;
  try {
    systemPrompt = buildSystemPrompt();
  } catch (err) {
    buildError = err.message;
  }
  const voiceDnaInPrompt = systemPrompt.includes('=== YOUR VOICE DNA');
  // Locate the voice DNA block so the dashboard can highlight it
  let voiceDnaBlock = null;
  if (voiceDnaInPrompt) {
    const start = systemPrompt.indexOf('=== YOUR VOICE DNA');
    const after = systemPrompt.indexOf('\n\n', start + 100);
    voiceDnaBlock = systemPrompt.slice(start, after === -1 ? undefined : after);
  }
  res.json({
    workspace: wsId,
    voiceDnaSnapshotExists: !!dna,
    voiceDnaInPrompt,
    voiceDnaBlock,
    promptLength: systemPrompt.length,
    systemPrompt,
    buildError,
  });
});

// POST /api/voice-dna/regenerate — trigger a fresh extraction now.
//   Body: { force?: boolean, workspace?: string }
//   Honors a 5-minute cooldown unless force=true.
router.post('/regenerate', async (req, res) => {
  const wsId = (req.body && req.body.workspace) || req.query.workspace || workspace.getId();
  const force = !!(req.body && req.body.force);
  try {
    const result = await voiceDna.regenerate(wsId, { force });
    if (!result.success) {
      const code = result.reason === 'cooldown' ? 429 : 400;
      return res.status(code).json({ workspace: wsId, ...result });
    }
    res.json({ workspace: wsId, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
