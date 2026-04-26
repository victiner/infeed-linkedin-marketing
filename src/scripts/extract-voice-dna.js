#!/usr/bin/env node
// CLI wrapper around services/voice-dna. The same code runs in the server's
// auto-trigger and the dashboard's "Regenerate now" button.
//
// Run: npm run extract-voice [-- --workspace=<id>] [-- --force]

require('dotenv').config();

const workspace = require('../services/workspace');
const store     = require('../services/store');
const voiceDna  = require('../services/voice-dna');

function parseArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

async function main() {
  const wsId = parseArg('workspace') || process.env.WORKSPACE_ID || 'infeed';
  const force = process.argv.includes('--force');

  workspace.load(wsId);
  await store.init();
  await store.loadTraining();
  await voiceDna.loadAll();

  console.log(`[ExtractVoice] Regenerating voice DNA for workspace "${wsId}"${force ? ' (forced)' : ''}...`);
  const result = await voiceDna.regenerate(wsId, { force });

  if (!result.success) {
    console.error(`[ExtractVoice] Failed (${result.reason}): ${result.message}`);
    process.exit(1);
  }

  console.log('\n=== EXTRACTED VOICE DNA ===\n');
  console.log(JSON.stringify(result.dna, null, 2));
  console.log(`\n[ExtractVoice] Generated at ${result.generatedAt}, based on ${result.basedOnCount} training records.`);
  console.log('[ExtractVoice] Stored in Airtable; live in the running server immediately.');
}

main().catch(err => {
  console.error('[ExtractVoice] Error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
