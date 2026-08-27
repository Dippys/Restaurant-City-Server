#!/usr/bin/env node
'use strict';

// Resolve the reviewable anomaly signals (staff over the level cap, menu
// dishes over the course cap, stored level behind gourmet) for every affected
// profile. Each fix takes a recovery snapshot first and records a moderation
// action, then re-scans the profile so the queue reflects the result.
//
// Requires the compiled build (`npm run build`) because it uses the moderation
// service. Read-only by default; --apply performs the fixes.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SIGNAL_RULES = ['EMPLOYEE_UNLOCK_EXCEEDED', 'MENU_UNLOCK_EXCEEDED', 'LEVEL_GOURMET_MISMATCH'];

function resolveDatabasePath(flagPath) {
  if (flagPath) return path.resolve(flagPath);
  if (process.env.RC_DB_PATH) return path.resolve(process.env.RC_DB_PATH);
  return path.resolve(__dirname, '..', 'dev.db');
}

function parseArgs(argv) {
  const options = { apply: false, database: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--database') options.database = String(argv[++index] || '');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/fix-anomaly-signals.cjs
  node scripts/fix-anomaly-signals.cjs --apply [--database PATH]

Options:
  --apply           Take snapshots and resolve the signals (fire over-cap staff,
                    deselect over-cap dishes, catch levels up)
  --database PATH   SQLite file (default: RC_DB_PATH or server/dev.db)
  -h, --help        Show this help

Run "npm run build" first. Without --apply the script only lists the plan.`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }

  const dbPath = resolveDatabasePath(options.database);
  if (!fs.existsSync(dbPath)) { console.error(`Database not found: ${dbPath}`); process.exit(1); }

  const db = new Database(dbPath, { readonly: true });
  const affected = db.prepare(`
    SELECT a.networkUid, a.ruleId, a.title, a.summary
    FROM AnomalyFinding a
    WHERE a.status IN ('OPEN','REVIEWED','CONFIRMED') AND a.ruleId IN (${SIGNAL_RULES.map(() => '?').join(',')})
    ORDER BY a.networkUid, a.ruleId
  `).all(...SIGNAL_RULES);
  const uids = [...new Set(affected.map((row) => row.networkUid))];
  console.log(`Database: ${dbPath}`);
  console.log(`Profiles with open staff/menu/level signals: ${uids.length}`);
  const byRule = {};
  for (const row of affected) byRule[row.ruleId] = (byRule[row.ruleId] ?? 0) + 1;
  console.log('by rule:', JSON.stringify(byRule));
  for (const row of affected.slice(0, 30)) console.log(`  ${row.networkUid} ${row.ruleId}: ${row.summary}`);
  if (affected.length > 30) console.log(`  … and ${affected.length - 30} more`);
  db.close();

  if (!options.apply) {
    console.log('\nRead-only: nothing changed. Re-run with --apply to resolve (requires `npm run build`).');
    return;
  }
  if (uids.length === 0) { console.log('Nothing to resolve.'); return; }

  process.env.RC_DB_PATH = dbPath;
  const { resolveAllSignalProfiles } = require('../dist/moderation/service.js');
  const actorDb = new Database(dbPath, { readonly: true });
  const admin = actorDb.prepare("SELECT id, username FROM Account WHERE role = 'ADMIN' ORDER BY createdAt LIMIT 1").get();
  actorDb.close();
  const actor = admin && admin.username ? { id: admin.id, username: admin.username } : { id: '', username: 'system' };
  resolveAllSignalProfiles(actor)
    .then((result) => {
      console.log('Resolved:', JSON.stringify(result));
      return require('../dist/db/client.js').prisma.$disconnect();
    })
    .then(() => process.exit(0))
    .catch((error) => { console.error(error); process.exit(1); });
}

main();
