#!/usr/bin/env node
'use strict';

// One-stop legacy-data repair for the RC Reborn server database.
//
// Read-only by default; --apply backs up the database first, then fixes:
//   1. OwnedItem primary-key/serverId drift            (ADR-0039 save crash)
//   2. ProfileSaveFact.clientDeltaSeconds stored in ms (anomaly false alarms)
//   3. Exact-position duplicate placements             (stacked furniture)
//   4. Duplicate facade singleton groups               (multi doors/roofs/...)
//   5. Unknown item identities (junk ids from the old digit-extraction parser)
//      — only with --delete-unknown
//
// Everything else the anomaly scanner reports (menu over-selection, staff over
// the level cap, level-behind-gourmet) is a *signal*, not provable damage: the
// script reports those counts but never mutates them.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const FACADE_SINGLETON_GROUPS = new Set([201, 202, 205, 206, 207]);
const DATA_FILES = ['front.xml', 'restaurant.xml', 'ingredient.xml', 'recipe.xml', 'perk.xml', 'avatar.xml', 'appointment.xml'];

function dataDir() {
  return path.resolve(__dirname, '..', 'public', 'data');
}

// ---------------------------------------------------------------------------
// Catalog helpers (from the same XMLs the server serves and the client loads)
// ---------------------------------------------------------------------------

/** All known item ids and the ids whose type contains "stackable". */
function buildCatalog() {
  const known = new Set();
  const stackable = new Set();
  for (const file of DATA_FILES) {
    let xml = '';
    try { xml = fs.readFileSync(path.join(dataDir(), file), 'utf8'); } catch { continue; }
    for (const match of xml.matchAll(/<item\b([^>]*)\/?>/g)) {
      const tag = match[1];
      const id = Number((tag.match(/\bid="(\d+)"/) || [])[1]);
      if (!Number.isInteger(id)) continue;
      known.add(id);
      if (/type="[^"]*stackable/.test(tag)) stackable.add(id);
    }
  }
  return { known, stackable };
}

function ownedKey(profileId, serverId) {
  return `${profileId}:owned:${serverId}`;
}

// ---------------------------------------------------------------------------
// Fixes (each takes a better-sqlite3 Database and returns a count object)
// ---------------------------------------------------------------------------

/** 1. Rename OwnedItem ids so id === facebook:<uid>:owned:<serverId>. */
function fixOwnedKeys(db) {
  const rows = db.prepare('SELECT userProfileId, id, serverId FROM OwnedItem').all();
  const byProfile = new Map();
  for (const row of rows) {
    const list = byProfile.get(row.userProfileId) ?? [];
    list.push(row);
    byProfile.set(row.userProfileId, list);
  }
  let repaired = 0;
  for (const [profileId, profileRows] of byProfile) {
    const mismatched = profileRows.filter((row) => row.id !== ownedKey(profileId, row.serverId));
    if (mismatched.length === 0) continue;
    const usedIds = new Set(profileRows.map((row) => row.id));
    const usedServerIds = new Set(profileRows.map((row) => row.serverId));
    let nextServerId = profileRows.reduce((max, row) => Math.max(max, row.serverId), 0) + 1;
    const rename = db.prepare('UPDATE OwnedItem SET id = ? WHERE id = ? AND userProfileId = ?');
    const renumber = db.prepare('UPDATE OwnedItem SET id = ?, serverId = ? WHERE id = ? AND userProfileId = ?');
    for (const row of mismatched) {
      const correctId = ownedKey(profileId, row.serverId);
      if (!usedIds.has(correctId)) {
        rename.run(correctId, row.id, profileId);
        usedIds.delete(row.id);
        usedIds.add(correctId);
      } else {
        while (usedIds.has(ownedKey(profileId, nextServerId)) || usedServerIds.has(nextServerId)) nextServerId += 1;
        const freshId = ownedKey(profileId, nextServerId);
        renumber.run(freshId, nextServerId, row.id, profileId);
        usedIds.delete(row.id);
        usedIds.add(freshId);
        usedServerIds.add(nextServerId);
        nextServerId += 1;
      }
      repaired += 1;
    }
  }
  return { repaired };
}

/** 2. Re-derive ProfileSaveFact.clientDeltaSeconds (was stored in ms). */
function fixSaveFactDeltas(db) {
  const facts = db.prepare('SELECT id, networkUid, saveVersion, clientTime, clientDeltaSeconds FROM ProfileSaveFact ORDER BY networkUid, createdAt').all();
  const byUid = new Map();
  const stmt = db.prepare('UPDATE ProfileSaveFact SET clientDeltaSeconds = ? WHERE id = ?');
  let updated = 0;
  for (const fact of facts) {
    const prev = byUid.get(fact.networkUid);
    let delta = 0;
    if (prev) {
      const sameSession = fact.saveVersion > prev.saveVersion;
      delta = sameSession ? Math.round((fact.clientTime - prev.clientTime) / 1000) : 0;
    }
    stmt.run(delta, fact.id);
    if (fact.clientDeltaSeconds !== delta) updated += 1;
    byUid.set(fact.networkUid, fact);
  }
  return { updated };
}

/** 3. Exact-position duplicate placements (non-stackable): keep newest, return older to inventory. */
function fixDuplicatePlacements(db, stackableIds) {
  const groups = db.prepare(`
    SELECT userProfileId, globalItemId, positionX, positionY, roomIndex, COUNT(*) c
    FROM OwnedItem
    GROUP BY userProfileId, globalItemId, positionX, positionY, roomIndex
    HAVING COUNT(*) > 1
  `).all();
  const fetch = db.prepare('SELECT id, serverId, globalItemId, updatedAt, createdAt FROM OwnedItem WHERE userProfileId = ? AND globalItemId = ? AND positionX = ? AND positionY = ? AND roomIndex = ? ORDER BY updatedAt DESC, createdAt DESC, serverId DESC');
  const remove = db.prepare('DELETE FROM OwnedItem WHERE id = ?');
  const addInventory = db.prepare(`
    INSERT INTO InventoryItem (id, userProfileId, globalItemId, number, isSelected, createdAt, updatedAt)
    VALUES (?, ?, ?, 1, 0, strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'), strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'))
    ON CONFLICT(userProfileId, globalItemId) DO UPDATE SET number = number + 1, updatedAt = strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')
  `);
  let groupsFixed = 0;
  let copiesReturned = 0;
  for (const group of groups) {
    if (stackableIds.has(group.globalItemId)) continue; // legitimately stackable
    const rows = fetch.all(group.userProfileId, group.globalItemId, group.positionX, group.positionY, group.roomIndex);
    if (rows.length < 2) continue;
    for (const row of rows.slice(1)) {
      remove.run(row.id);
      addInventory.run(`${group.userProfileId}:inventory:${group.globalItemId}`, group.userProfileId, group.globalItemId);
      copiesReturned += 1;
    }
    groupsFixed += 1;
  }
  return { groupsFixed, copiesReturned };
}

/** 4. Duplicate facade singleton groups (201/202/205/206/207): keep newest, return older to inventory. */
function fixFacadeSingletons(db) {
  const rows = db.prepare('SELECT id, userProfileId, globalItemId, updatedAt, createdAt, serverId FROM OwnedItem').all();
  const byProfileGroup = new Map();
  for (const row of rows) {
    const group = Math.floor(row.globalItemId / 10_000);
    if (!FACADE_SINGLETON_GROUPS.has(group)) continue;
    const key = `${row.userProfileId}:${group}`;
    const list = byProfileGroup.get(key) ?? [];
    list.push(row);
    byProfileGroup.set(key, list);
  }
  const remove = db.prepare('DELETE FROM OwnedItem WHERE id = ?');
  const addInventory = db.prepare(`
    INSERT INTO InventoryItem (id, userProfileId, globalItemId, number, isSelected, createdAt, updatedAt)
    VALUES (?, ?, ?, 1, 0, strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'), strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'))
    ON CONFLICT(userProfileId, globalItemId) DO UPDATE SET number = number + 1, updatedAt = strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')
  `);
  let groupsFixed = 0;
  let copiesReturned = 0;
  for (const [key, list] of byProfileGroup) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || '')
      || (b.createdAt || '').localeCompare(a.createdAt || '')
      || b.serverId - a.serverId);
    for (const row of sorted.slice(1)) {
      remove.run(row.id);
      addInventory.run(`${row.userProfileId}:inventory:${row.globalItemId}`, row.userProfileId, row.globalItemId);
      copiesReturned += 1;
    }
    groupsFixed += 1;
  }
  return { groupsFixed, copiesReturned };
}

/** 5. Delete rows whose globalItemId does not exist in the shipped game data. */
function deleteUnknownItems(db, knownIds) {
  const owned = db.prepare('DELETE FROM OwnedItem WHERE globalItemId NOT IN (SELECT value FROM json_each(?))');
  const inventory = db.prepare('DELETE FROM InventoryItem WHERE globalItemId NOT IN (SELECT value FROM json_each(?))');
  const ingredients = db.prepare('DELETE FROM IngredientInventory WHERE globalItemId NOT IN (SELECT value FROM json_each(?))');
  const garden = db.prepare('UPDATE GardenPlot SET ingredientId = 0 WHERE ingredientId > 0 AND ingredientId NOT IN (SELECT value FROM json_each(?))');
  const ids = JSON.stringify([...knownIds]);
  const count = (sql) => sql.run(ids).changes;
  return {
    ownedDeleted: count(owned),
    inventoryDeleted: count(inventory),
    ingredientDeleted: count(ingredients),
    gardenReset: count(garden),
  };
}

// ---------------------------------------------------------------------------
// Analysis / plan (read-only)
// ---------------------------------------------------------------------------

function analyze(db, catalog) {
  const ownedTotal = db.prepare('SELECT COUNT(*) c FROM OwnedItem').get().c;
  const keyMismatches = db.prepare("SELECT COUNT(*) c FROM OwnedItem WHERE id != (userProfileId || ':owned:' || serverId)").get().c;

  const implausibleFacts = db.prepare('SELECT COUNT(*) c FROM ProfileSaveFact WHERE clientDeltaSeconds > 100000 OR clientDeltaSeconds < -100').get().c;

  const exactDupGroups = db.prepare(`
    SELECT globalItemId, COUNT(*) c FROM OwnedItem
    GROUP BY userProfileId, globalItemId, positionX, positionY, roomIndex
    HAVING COUNT(*) > 1
  `).all();
  const stackableDupGroups = exactDupGroups.filter((g) => catalog.stackable.has(g.globalItemId)).length;
  const nonStackableDupGroups = exactDupGroups.length - stackableDupGroups;

  const facadeGroups = db.prepare(`
    SELECT userProfileId, (globalItemId / 10000) AS groupId, COUNT(*) c
    FROM OwnedItem
    WHERE (globalItemId / 10000) IN (201, 202, 205, 206, 207)
    GROUP BY userProfileId, groupId HAVING COUNT(*) > 1
  `).all().length;

  const unknown = {
    owned: db.prepare('SELECT COUNT(*) c FROM OwnedItem WHERE globalItemId NOT IN (SELECT value FROM json_each(?))').get(JSON.stringify([...catalog.known])).c,
    inventory: db.prepare('SELECT COUNT(*) c FROM InventoryItem WHERE globalItemId NOT IN (SELECT value FROM json_each(?))').get(JSON.stringify([...catalog.known])).c,
    ingredients: db.prepare('SELECT COUNT(*) c FROM IngredientInventory WHERE globalItemId NOT IN (SELECT value FROM json_each(?))').get(JSON.stringify([...catalog.known])).c,
    garden: db.prepare('SELECT COUNT(*) c FROM GardenPlot WHERE ingredientId > 0 AND ingredientId NOT IN (SELECT value FROM json_each(?))').get(JSON.stringify([...catalog.known])).c,
  };

  return {
    ownedTotal,
    keyMismatches,
    implausibleFacts,
    exactDupGroups: nonStackableDupGroups,
    stackableDupGroups,
    facadeGroups,
    unknown,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { apply: false, deleteUnknown: false, database: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--delete-unknown') options.deleteUnknown = true;
    else if (arg === '--database') options.database = String(argv[++index] || '');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function resolveDatabasePath(flagPath) {
  if (flagPath) return path.resolve(flagPath);
  if (process.env.RC_DB_PATH) return path.resolve(process.env.RC_DB_PATH);
  return path.resolve(__dirname, '..', 'dev.db');
}

function printHelp() {
  console.log(`Usage:
  node scripts/fix-legacy-data.cjs
  node scripts/fix-legacy-data.cjs --apply [--delete-unknown]

Options:
  --database PATH     SQLite file (default: RC_DB_PATH or server/dev.db)
  --apply             Create a backup, then fix keys, fact units, duplicate
                      placements, and facade singletons
  --delete-unknown    Also delete rows whose item id does not exist in the
                      shipped game data (junk from the old parser)
  -h, --help          Show this help

Without --apply the script is read-only and prints the full plan.`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }

  const dbPath = resolveDatabasePath(options.database);
  if (!fs.existsSync(dbPath)) { console.error(`Database not found: ${dbPath}`); process.exit(1); }

  const catalog = buildCatalog();
  const db = new Database(dbPath, { readonly: !options.apply });

  if (options.apply) {
    const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(dbPath, backupPath);
    console.log(`Backup: ${backupPath}`);
    console.log('Applying fixes…');
    console.log(`  keys: ${JSON.stringify(fixOwnedKeys(db))}`);
    console.log(`  facts: ${JSON.stringify(fixSaveFactDeltas(db))}`);
    console.log(`  duplicates: ${JSON.stringify(fixDuplicatePlacements(db, catalog.stackable))}`);
    console.log(`  facade: ${JSON.stringify(fixFacadeSingletons(db))}`);
    if (options.deleteUnknown) {
      console.log(`  unknown: ${JSON.stringify(deleteUnknownItems(db, catalog.known))}`);
    } else {
      console.log('  unknown: skipped (re-run with --delete-unknown to remove junk ids)');
    }
  }

  const plan = analyze(db, catalog);
  db.close();

  console.log(`Database: ${dbPath}`);
  console.log('Plan:');
  console.log(`  OwnedItem rows: ${plan.ownedTotal}`);
  console.log(`  id/serverId mismatches: ${plan.keyMismatches}`);
  console.log(`  save-facts with implausible (ms) deltas: ${plan.implausibleFacts}`);
  console.log(`  exact-position duplicate groups (non-stackable): ${plan.exactDupGroups} (${plan.stackableDupGroups} stackable groups preserved)`);
  console.log(`  facade singleton groups with duplicates: ${plan.facadeGroups}`);
  console.log(`  unknown item rows: owned ${plan.unknown.owned}, inventory ${plan.unknown.inventory}, ingredients ${plan.unknown.ingredients}, garden ${plan.unknown.garden}`);
  if (!options.apply) console.log('\nRead-only: nothing changed. Re-run with --apply to repair.');
}

module.exports = { buildCatalog, fixOwnedKeys, fixSaveFactDeltas, fixDuplicatePlacements, fixFacadeSingletons, deleteUnknownItems, analyze };

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
