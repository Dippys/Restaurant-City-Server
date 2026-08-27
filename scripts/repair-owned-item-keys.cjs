#!/usr/bin/env node
'use strict';

// ADR-0039: repair OwnedItem rows whose primary-key id is out of sync with
// their serverId (legacy rows can hold `…:owned:<negative>` ids while
// serverId was renumbered positive). Those stale ids collide with fresh
// client negative uids in `ownedItem.upsert()` and crash the save with
// "Unique constraint failed on the fields: (id)".
//
// Read-only by default; --apply backs up the database first.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

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
  node scripts/repair-owned-item-keys.cjs
  node scripts/repair-owned-item-keys.cjs --apply

Options:
  --database PATH   SQLite file (default: RC_DB_PATH or server/dev.db)
  --apply           Create a backup, then repair every affected profile
  -h, --help        Show this help

Without --apply the script is read-only and prints the full plan.`);
}

function ownedKey(profileId, serverId) {
  return `${profileId}:owned:${serverId}`;
}

function repairPlan(db, profileIds) {
  const plan = [];
  for (const profileId of profileIds) {
    const rows = db.prepare(
      'SELECT id, serverId FROM OwnedItem WHERE userProfileId = ?',
    ).all(profileId);
    const mismatched = rows.filter((row) => row.id !== ownedKey(profileId, row.serverId));
    if (mismatched.length === 0) continue;

    const usedIds = new Set(rows.map((row) => row.id));
    const usedServerIds = new Set(rows.map((row) => row.serverId));
    let nextServerId = rows.reduce((max, row) => Math.max(max, row.serverId), 0) + 1;
    const actions = [];

    for (const row of mismatched) {
      const correctId = ownedKey(profileId, row.serverId);
      if (!usedIds.has(correctId)) {
        actions.push({ id: row.id, newId: correctId, newServerId: row.serverId });
        usedIds.delete(row.id);
        usedIds.add(correctId);
      } else {
        while (usedIds.has(ownedKey(profileId, nextServerId)) || usedServerIds.has(nextServerId)) {
          nextServerId += 1;
        }
        const freshId = ownedKey(profileId, nextServerId);
        actions.push({ id: row.id, newId: freshId, newServerId: nextServerId });
        usedIds.delete(row.id);
        usedIds.add(freshId);
        usedServerIds.add(nextServerId);
        nextServerId += 1;
      }
    }
    plan.push({ profileId, count: mismatched.length, actions });
  }
  return plan;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const dbPath = resolveDatabasePath(options.database);
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: !options.apply });
  const profileIds = db.prepare(
    'SELECT DISTINCT userProfileId FROM OwnedItem ORDER BY userProfileId',
  ).all().map((row) => row.userProfileId);

  const plan = repairPlan(db, profileIds);
  db.close();

  const total = plan.reduce((sum, entry) => sum + entry.count, 0);
  console.log(`Database: ${dbPath}`);
  console.log(`Profiles with mismatched keys: ${plan.length}`);
  console.log(`Rows to repair: ${total}`);
  for (const entry of plan.slice(0, 25)) {
    console.log(`  ${entry.profileId}: ${entry.count} row${entry.count === 1 ? '' : 's'}`);
  }
  if (plan.length > 25) console.log(`  … and ${plan.length - 25} more profile(s)`);

  if (!options.apply) {
    console.log('\nRead-only: nothing changed. Re-run with --apply to repair.');
    return;
  }
  if (total === 0) {
    console.log('Nothing to repair.');
    return;
  }

  const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(dbPath, backupPath);
  console.log(`\nBackup: ${backupPath}`);

  const writable = new Database(dbPath);
  const update = writable.prepare(
    'UPDATE OwnedItem SET id = ?, serverId = ? WHERE id = ? AND userProfileId = ?',
  );
  let repaired = 0;
  const run = writable.transaction((entries) => {
    for (const entry of entries) {
      for (const action of entry.actions) {
        const result = update.run(action.newId, action.newServerId, action.id, entry.profileId);
        repaired += result.changes;
      }
    }
  });
  run(plan);
  writable.close();

  const verify = new Database(dbPath, { readonly: true });
  const remaining = verify.prepare(
    "SELECT COUNT(*) c FROM OwnedItem WHERE id != (userProfileId || ':owned:' || serverId)",
  ).get().c;
  verify.close();

  console.log(`Repaired rows: ${repaired}`);
  console.log(`Remaining mismatched rows: ${remaining}`);
  console.log(remaining === 0 ? 'OK: keys are consistent.' : 'WARNING: some rows remain (re-run).');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
