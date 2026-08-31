#!/usr/bin/env node
'use strict';

// Removes items players are not supposed to have, after the sendMail /
// mystery-box / save-audit mint holes are closed. The 3 Million Fans Statue
// (3500093) and other invisible/non-shop catalog rows could previously be
// minted into any profile through crafted RPCs, because the server trusted
// client-supplied item ids. This script sweeps the stored profiles:
//
//   1. Unknown item ids (not present in any shipped data XML) — always
//      illegitimate; nothing in game data can ever reference them.
//   2. Invisible catalog items (invisible="true", e.g. 3500093) — illegitimate
//      UNLESS the profile can justify them:
//        - the id is a game-earned award (Award group 3100000..3400044), or
//        - the id is foodKingFeed (legitimate Food King reward), or
//        - a Mail row from a legitimate sender (system uid "1", a seeded NPC
//          friend, or an ADMIN account) granted that item to the profile, or
//        - the operator keeps it explicitly via --keep.
//
// Read-only by default; --apply backs the SQLite file up first and deletes.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SYSTEM_NETWORK_UID = '1';

function resolveDatabasePath(flagPath) {
  if (flagPath) return path.resolve(flagPath);
  if (process.env.RC_DB_PATH) return path.resolve(process.env.RC_DB_PATH);
  return path.resolve(__dirname, '..', 'dev.db');
}

function parseArgs(argv) {
  const options = { apply: false, database: '', items: [], keep: [], unknown: true, invisible: true, purgeMail: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--database') options.database = String(argv[++index] || '');
    else if (arg === '--items') options.items = String(argv[++index] || '').split(',').map((s) => Number(s.trim())).filter(Number.isInteger);
    else if (arg === '--keep') options.keep = String(argv[++index] || '').split(',').map((s) => Number(s.trim())).filter(Number.isInteger);
    else if (arg === '--no-unknown') options.unknown = false;
    else if (arg === '--no-invisible') options.invisible = false;
    else if (arg === '--purge-mail') options.purgeMail = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/remove-illegitimate-items.cjs [--apply] [--database PATH] [--items 3500093,...] [--keep 3500091,...] [--purge-mail]

Options:
  --apply           Delete the flagged rows (backup first)
  --database PATH   SQLite file (default: RC_DB_PATH or dev.db)
  --items IDS       Force-remove these ids everywhere (comma separated)
  --keep IDS        Never remove these ids, even when invisible (comma separated)
  --no-unknown      Skip the unknown-id sweep
  --no-invisible    Skip the invisible-item sweep
  --purge-mail      Also delete Mail rows that carried a removed id from a
                    non-legitimate sender
  -h, --help        Show this help

Defaults: read-only report of unknown ids + unjustified invisible catalog ids.
Awards (3100000..3400044), foodKingFeed items, items granted by system/NPC/admin
mail, and --keep ids are always kept.`);
}

function parseItemTags(xml) {
  const items = [];
  const itemTag = /<item\b([^>]*)\/?>/g;
  const attr = (tag, key) => (tag.match(new RegExp(`\\b${key}="([^"]*)"`)) || [])[1] ?? '';
  for (const m of xml.matchAll(itemTag)) {
    const id = Number(attr(m[1], 'id'));
    if (!Number.isInteger(id)) continue;
    items.push({ id, invisible: attr(m[1], 'invisible') === 'true', foodKing: attr(m[1], 'foodKingFeed') === 'true' });
  }
  return items;
}

function buildCatalogSets(dataDir) {
  const known = new Set();
  const invisible = new Set();
  const foodKing = new Set();
  const award = new Set();
  const files = ['front.xml', 'restaurant.xml', 'ingredient.xml', 'recipe.xml', 'perk.xml', 'avatar.xml', 'appointment.xml'];

  for (const file of files) {
    let xml;
    try { xml = fs.readFileSync(path.join(dataDir, file), 'utf8'); } catch { continue; }
    for (const item of parseItemTags(xml)) {
      known.add(item.id);
      if (item.invisible) invisible.add(item.id);
      if (item.foodKing) foodKing.add(item.id);
    }
    // Award group: earned via gameplay, invisible in the shop but legitimate.
    if (file === 'restaurant.xml') {
      const groupBlock = /<group\b([^>]*)>([\s\S]*?)<\/group>/g;
      for (const g of xml.matchAll(groupBlock)) {
        if (!/\bname="Award"\b/.test(g[1] ?? '')) continue;
        for (const item of parseItemTags(g[2] ?? '')) award.add(item.id);
      }
    }
  }
  return { known, invisible, foodKing, award };
}

function legitimateSenderUids(db) {
  const uids = new Set([SYSTEM_NETWORK_UID]);
  for (const row of db.prepare("SELECT networkUid FROM Account WHERE role = 'ADMIN'").all()) {
    uids.add(String(row.networkUid));
  }
  return uids;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }

  const dbPath = resolveDatabasePath(options.database);
  if (!fs.existsSync(dbPath)) { console.error(`Database not found: ${dbPath}`); process.exit(1); }
  const dataDir = path.resolve(__dirname, '..', 'public', 'data');
  const sets = buildCatalogSets(dataDir);
  const db = new Database(dbPath, { readonly: true });
  const legitSenders = legitimateSenderUids(db);
  console.log(`Database: ${dbPath}`);
  console.log(`Catalog: ${sets.known.size} known ids, ${sets.invisible.size} invisible, ${sets.award.size} award, ${sets.foodKing.size} foodKing`);
  console.log(`Legitimate mail senders: ${[...legitSenders].join(', ') || '(none)'}`);

  const kept = new Set(options.keep);
  const forced = new Set(options.items);
  const flagged = new Map(); // profileId -> { rows: [...], mail: [...] }

  const legitMailByProfile = new Map();
  const mailRows = db.prepare(`
    SELECT id, recipientProfileId, senderNetworkUid, globalItemIdsJson, type
    FROM Mail WHERE deleted = 0
  `).all();
  for (const m of mailRows) {
    if (!legitSenders.has(String(m.senderNetworkUid))) continue;
    let ids = [];
    try { ids = JSON.parse(m.globalItemIdsJson || '[]'); } catch { continue; }
    if (!Array.isArray(ids)) continue;
    if (!legitMailByProfile.has(m.recipientProfileId)) legitMailByProfile.set(m.recipientProfileId, new Set());
    for (const id of ids) legitMailByProfile.get(m.recipientProfileId).add(Number(id));
  }

  function illegitimate(id) {
    if (kept.has(id)) return false;
    if (forced.has(id)) return true; // explicit operator purge wins over everything
    if (!sets.known.has(id)) return options.unknown;   // unknown id sweep
    if (sets.award.has(id)) return false;              // earned award
    if (sets.foodKing.has(id)) return false;           // legit food king feed
    if (sets.invisible.has(id)) return options.invisible; // invisible sweep (justified below)
    return false;
  }

  function scanTable(table, idColumn, profileColumn) {
    const rows = db.prepare(`SELECT id, ${profileColumn} AS profileId, ${idColumn} AS itemId FROM ${table}`).all();
    for (const row of rows) {
      const id = Number(row.itemId);
      if (!illegitimate(id)) continue;
      // An invisible item granted by a legitimate mail is operator-sanctioned.
      if (!forced.has(id) && sets.invisible.has(id) && legitMailByProfile.get(row.profileId)?.has(id)) continue;
      const bucket = flagged.get(row.profileId) || { rows: [], mail: [] };
      bucket.rows.push({ table, rowId: row.id, itemId: id });
      flagged.set(row.profileId, bucket);
    }
  }

  scanTable('InventoryItem', 'globalItemId', 'userProfileId');
  scanTable('OwnedItem', 'globalItemId', 'userProfileId');
  scanTable('IngredientInventory', 'globalItemId', 'userProfileId');

  // Garden plots referencing a removed/unknown ingredient.
  const plots = db.prepare('SELECT id, userProfileId AS profileId, ingredientId FROM GardenPlot WHERE ingredientId > 0').all();
  for (const plot of plots) {
    const id = Number(plot.ingredientId);
    if (!illegitimate(id)) continue;
    const bucket = flagged.get(plot.profileId) || { rows: [], mail: [] };
    bucket.rows.push({ table: 'GardenPlot', rowId: plot.id, itemId: id, number: 1 });
    flagged.set(plot.profileId, bucket);
  }

  // Mail rows that carried a removed id from a non-legitimate sender.
  const mailByProfile = new Map();
  for (const m of mailRows) {
    let ids = [];
    try { ids = JSON.parse(m.globalItemIdsJson || '[]'); } catch { continue; }
    if (!Array.isArray(ids)) continue;
    if (!mailByProfile.has(m.recipientProfileId)) mailByProfile.set(m.recipientProfileId, []);
    mailByProfile.get(m.recipientProfileId).push({ mail: m, ids: ids.map(Number) });
  }
  for (const [profileId, list] of mailByProfile) {
    for (const { mail, ids } of list) {
      const carriedRemoved = ids.some((id) => illegitimate(id) && !(sets.invisible.has(id) && legitMailByProfile.get(profileId)?.has(id)));
      if (!carriedRemoved) continue;
      const bucket = flagged.get(profileId) || { rows: [], mail: [] };
      bucket.mail.push({ mailId: mail.id, sender: mail.senderNetworkUid, itemIds: ids });
      flagged.set(profileId, bucket);
    }
  }

  const totalRows = [...flagged.values()].reduce((sum, b) => sum + b.rows.length, 0);
  const totalMail = [...flagged.values()].reduce((sum, b) => sum + b.mail.length, 0);
  console.log(`\nProfiles with illegitimate rows: ${flagged.size}`);
  console.log(`Rows to remove: ${totalRows}, exploit mail rows: ${totalMail}`);

  const byTable = {};
  for (const bucket of flagged.values()) {
    for (const row of bucket.rows) byTable[row.table] = (byTable[row.table] ?? 0) + 1;
  }
  for (const [table, count] of Object.entries(byTable)) console.log(`  ${table}: ${count}`);

  for (const [profileId, bucket] of [...flagged.entries()].slice(0, 40)) {
    const ids = [...new Set(bucket.rows.map((r) => r.itemId))].slice(0, 8);
    console.log(`  ${profileId}: items ${ids.join(',')}${bucket.mail.length ? `, mail x${bucket.mail.length}` : ''}`);
  }
  if (flagged.size > 40) console.log(`  … and ${flagged.size - 40} more profiles`);
  db.close();

  if (!options.apply) {
    console.log('\nRead-only: nothing changed. Re-run with --apply to delete the flagged rows.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.bak-${stamp}`;
  fs.copyFileSync(dbPath, backupPath);
  console.log(`\nBackup: ${backupPath}`);

  const write = new Database(dbPath);
  const del = write.transaction(() => {
    let rows = 0;
    let mails = 0;
    for (const bucket of flagged.values()) {
      for (const row of bucket.rows) {
        if (row.table === 'GardenPlot') {
          write.prepare('UPDATE GardenPlot SET ingredientId = 0 WHERE id = ?').run(row.rowId);
        } else {
          write.prepare(`DELETE FROM ${row.table} WHERE id = ?`).run(row.rowId);
        }
        rows += 1;
      }
      if (options.purgeMail) {
        for (const m of bucket.mail) {
          if (legitSenders.has(String(m.sender))) continue;
          write.prepare('DELETE FROM Mail WHERE id = ?').run(m.mailId);
          mails += 1;
        }
      }
    }
    return { rows, mails };
  });
  const { rows, mails } = del();
  write.close();
  console.log(`Deleted ${rows} rows${options.purgeMail ? ` and ${mails} exploit mails` : ''} (mail rows kept; re-run with --purge-mail to delete them).`);
}

main();
