#!/usr/bin/env node
'use strict';

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => !['--apply', '--help', '-h'].includes(arg))) throw new Error('Usage: npm run repair:ingredient-rewards -- [--apply]');
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: npm run repair:ingredient-rewards -- [--apply]\n\nRead-only by default. Stop the server before --apply.');
    return;
  }
  const { prisma } = require('../dist/db/client.js');
  const { repairMissingIngredientRewards } = require('../dist/db/ingredient-reward-repair.js');
  try {
    const result = await repairMissingIngredientRewards(args.has('--apply'));
    console.log(`Missing first-visit rewards: ${result.missingFirstVisitRewards}`);
    console.log(`Missing correct-quiz rewards: ${result.missingQuizRewards}`);
    console.log(`Ignored invalid/unrecoverable quiz events: ${result.invalidQuizEvents}`);
    if (result.apply) console.log(`Granted ${result.rewardsGranted} missing ingredient rewards with durable idempotency markers.`);
    else console.log('Read-only: nothing changed. Re-run with --apply after stopping the server.');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
