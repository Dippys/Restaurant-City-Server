#!/usr/bin/env node
'use strict';

// ADR-0042: sweep exact-position owned-item phantoms from a production
// database. The pre-fix renumber-on-internal-read loop duplicated one physical
// item into several rows sharing (globalItemId, positionX, positionY,
// roomIndex). Two identical non-stackable items can never legitimately share a
// tile, so the newest row is kept and the older phantoms are DELETED (they were
// never purchased — returning them to inventory would mint free items).
// Stackable items (type contains "stackable"), wall decorations, and façade
// singleton groups (201/202/205/206/207) are exempt because multiple copies at
// one position are legitimate there.
//
// Read-only by default; --apply backs the SQLite file up first.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const FACADE_SINGLETON_GROUPS = new Set([201, 202, 205, 206, 207]);

function resolveDatabasePath(flagPath) {
  if (flagPath) return path.resolve(flagPath);
  if (process.env.RC_DB_PATH) return path.resolve(process.env.RC_DB_PATH);
  return path.resolve(__dirname, '..', 'dev.db');
}

function parseArgs(argv) {
  const options = { apply: false, database: '', help: false };
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
  node scripts/dedupe-owned-items.cjs [--apply] [--database PATH]

Options:
  --apply           Delete phantom duplicate rows (keep the newest per placement)
  --database PATH   SQLite file (default: RC_DB_PATH or dev.db)
  -h, --help        Show this help

Exempt (never deduplicated): stackable items, wall decorations, façade groups
201/202/205/206/207, non-restaurant ranges (avatar 1xxxxxx, building 2xxxxxx),
and anything not in restaurant.xml/front.xml/perk.xml/avatar.xml.`);
}

function buildExemptionSets(dataDir) {
  const stackable = new Set();
  const wall = new Set();
  const known = new Set();
  const itemTag = /<item\b([^>]*)\/?>/g;
  const attr = (tag, key) => (tag.match(new RegExp(`\\b${key}="([^"]*)"`)) || [])[1] ?? '';

  const files = ['restaurant.xml', 'front.xml', 'perk.xml', 'avatar.xml'];
  for (const file of files) {
    let xml;
    try { xml = fs.readFileSync(path.join(dataDir, file), 'utf8'); } catch { continue; }
    for (const m of xml.matchAll(itemTag)) {
      const id = Number(attr(m[1], 'id'));
      if (!Number.isInteger(id)) continue;
      known.add(id);
      if (/type="[^"]*stackable/.test(m[1])) stackable.add(id);
    }
    if (file === 'restaurant.xml') {
      const groupBlock = /<group\b([^>]*)>([\s\S]*?)<\/group>/g;
      for (const g of xml.matchAll(groupBlock)) {
        if (!/\btype="[^"]*\bwallDecorationItem\b[^"]*"/.test(g[1] ?? '')) continue;
        for (const m of (g[2] ?? '').matchAll(itemTag)) {
          const id = Number(attr(m[1], 'id'));
          if (Number.isInteger(id)) wall.add(id);
        }
      }
    }
  }
  return { stackable, wall, known };
}

function exempted(id, { stackable, wall, known }) {
  if (!known.has(id)) return true; // unknown items: hands off
  // Restaurant-range owned items only: avatar wardrobe rows (1xxxxxx) and
  // building layers (2xxxxxx) legitimately pile up at one position.
  if (id < 3000000 || id >= 8000000) return true;
  if (stackable.has(id)) return true;
  if (wall.has(id)) return true;
  return FACADE_SINGLETON_GROUPS.has(Math.floor(id / 10_000));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }

  const dbPath = resolveDatabasePath(options.database);
  if (!fs.existsSync(dbPath)) { console.error(`Database not found: ${dbPath}`); process.exit(1); }
  const dataDir = path.resolve(__dirname, '..', 'public', 'data');
  const sets = buildExemptionSets(dataDir);
  console.log(`Database: ${dbPath}`);
  console.log(`Exemptions: ${sets.stackable.size} stackable, ${sets.wall.size} wall, ${sets.known.size} known item ids`);

  const db = new Database(dbPath, { readonly: true });
  const groups = db.prepare(`
    SELECT userProfileId, globalItemId, positionX, positionY, roomIndex, COUNT(*) AS n,
           GROUP_CONCAT(id) AS ids, GROUP_CONCAT(serverId) AS sids, GROUP_CONCAT(updatedAt) AS ups
    FROM OwnedItem
    GROUP BY userProfileId, globalItemId, positionX, positionY, roomIndex
    HAVING COUNT(*) > 1
  `).all();

  const phantoms = groups.filter((g) => !exempted(g.globalItemId, sets));
  const exemptedGroups = groups.length - phantoms.length;
  const phantomRows = phantoms.reduce((sum, g) => sum + g.n - 1, 0);
  console.log(`Placement groups with >1 row: ${groups.length} (${exemptedGroups} exempt)`);
  console.log(`Phantom rows that would be deleted: ${phantomRows} across ${phantoms.length} groups, ${new Set(phantoms.map((g) => g.userProfileId)).size} profiles`);

  for (const g of phantoms.slice(0, 40)) {
    console.log(`  ${g.userProfileId} item=${g.globalItemId} (${g.positionX},${g.positionY}) room=${g.roomIndex} x${g.n} sids=${g.sids}`);
  }
  if (phantoms.length > 40) console.log(`  … and ${phantoms.length - 40} more groups`);
  db.close();

  if (!options.apply) {
    console.log('\nRead-only: nothing changed. Re-run with --apply to delete the phantoms.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.bak-${stamp}`;
  fs.copyFileSync(dbPath, backupPath);
  console.log(`Backup: ${backupPath}`);

  const write = new Database(dbPath);
  const selectGroup = write.prepare(`
    SELECT id FROM OwnedItem
    WHERE userProfileId = ? AND globalItemId = ? AND positionX = ? AND positionY = ? AND roomIndex = ?
    ORDER BY datetime(updatedAt) DESC, serverId DESC
  `);
  const deleteById = write.prepare('DELETE FROM OwnedItem WHERE id = ?');
  let deleted = 0;
  const apply = write.transaction(() => {
    for (const g of phantoms) {
      const rows = selectGroup.all(g.userProfileId, g.globalItemId, g.positionX, g.positionY, g.roomIndex);
      for (const row of rows.slice(1)) {
        deleteById.run(row.id);
        deleted += 1;
      }
    }
  });
  apply();
  write.close();
  console.log(`Deleted ${deleted} phantom rows.`);
}

main();
