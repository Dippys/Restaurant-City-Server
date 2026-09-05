#!/usr/bin/env node
'use strict';

// Removes crafted type-4 gift mail carrying coin reward tokens. Read-only by
// default. --apply creates a database backup, deletes every matching Mail row,
// and removes the reward token from all stored item tables. If a matching mail
// was already opened, --revoke-opened-coins also subtracts the token's catalog
// coin value once per opened mail (clamped at zero).

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_ITEM_IDS = [6020019];

function resolveDatabasePath(flagPath) {
  if (flagPath) return path.resolve(flagPath);
  if (process.env.RC_DB_PATH) return path.resolve(process.env.RC_DB_PATH);
  return path.resolve(__dirname, '..', 'dev.db');
}

function parseArgs(argv) {
  const options = { apply: false, database: '', itemIds: DEFAULT_ITEM_IDS, revokeOpenedCoins: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--database') options.database = String(argv[++index] || '');
    else if (arg === '--items') {
      options.itemIds = String(argv[++index] || '').split(',').map((value) => Number(value.trim())).filter(Number.isInteger);
    } else if (arg === '--revoke-opened-coins') options.revokeOpenedCoins = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.itemIds.length === 0) throw new Error('--items must contain at least one integer item id.');
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/remove-coin-reward-gifts.cjs [--database PATH]
  node scripts/remove-coin-reward-gifts.cjs --apply [--database PATH] [--revoke-opened-coins]

Options:
  --apply                 Back up the database, then remove matching mail/items
  --database PATH         SQLite file (default: RC_DB_PATH or dev.db)
  --items IDS             Reward item ids (default: 6020019)
  --revoke-opened-coins   Also subtract each opened token's catalog coin value
  -h, --help              Show this help

Stop the server before applying. Without --apply this command only reports the plan.`);
}

function readCoinValues(itemIds) {
  const xmlPath = path.resolve(__dirname, '..', 'public', 'data', 'perk.xml');
  const xml = fs.readFileSync(xmlPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const values = new Map();
  for (const match of xml.matchAll(/<item\b([^>]*)\/?\s*>/g)) {
    const attrs = match[1];
    const id = Number((attrs.match(/\bid="(\d+)"/) || [])[1]);
    const cost = Number((attrs.match(/\bcost="(\d+)"/) || [])[1]);
    if (itemIds.has(id) && /\bfanPageFeed="true"/.test(attrs) && Number.isSafeInteger(cost) && cost > 0) values.set(id, cost);
  }
  return values;
}

function readItemIds(json) {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function analyze(db, itemIds, coinValues) {
  const mails = [];
  const creditRevocations = new Map();
  for (const mail of db.prepare('SELECT id, recipientProfileId, globalItemIdsJson, read FROM Mail WHERE type = 4').all()) {
    const matches = readItemIds(mail.globalItemIdsJson).filter((id) => itemIds.has(id));
    if (matches.length === 0) continue;
    mails.push({ id: mail.id, recipientProfileId: mail.recipientProfileId, read: Boolean(mail.read), itemIds: matches });
    if (mail.read) {
      const amount = matches.reduce((sum, id) => sum + (coinValues.get(id) ?? 0), 0);
      creditRevocations.set(mail.recipientProfileId, (creditRevocations.get(mail.recipientProfileId) ?? 0) + amount);
    }
  }

  const placeholders = [...itemIds].map(() => '?').join(',');
  const ids = [...itemIds];
  const tableCounts = {
    InventoryItem: db.prepare(`SELECT COUNT(*) AS count FROM InventoryItem WHERE globalItemId IN (${placeholders})`).get(...ids).count,
    OwnedItem: db.prepare(`SELECT COUNT(*) AS count FROM OwnedItem WHERE globalItemId IN (${placeholders})`).get(...ids).count,
    IngredientInventory: db.prepare(`SELECT COUNT(*) AS count FROM IngredientInventory WHERE globalItemId IN (${placeholders})`).get(...ids).count,
    GardenPlot: db.prepare(`SELECT COUNT(*) AS count FROM GardenPlot WHERE ingredientId IN (${placeholders})`).get(...ids).count,
  };
  return { mails, creditRevocations, tableCounts };
}

function applyPlan(db, plan, itemIds, revokeOpenedCoins) {
  const placeholders = [...itemIds].map(() => '?').join(',');
  const ids = [...itemIds];
  return db.transaction(() => {
    let mailsDeleted = 0;
    const deleteMail = db.prepare('DELETE FROM Mail WHERE id = ?');
    for (const mail of plan.mails) mailsDeleted += deleteMail.run(mail.id).changes;

    const rowsDeleted = {
      InventoryItem: db.prepare(`DELETE FROM InventoryItem WHERE globalItemId IN (${placeholders})`).run(...ids).changes,
      OwnedItem: db.prepare(`DELETE FROM OwnedItem WHERE globalItemId IN (${placeholders})`).run(...ids).changes,
      IngredientInventory: db.prepare(`DELETE FROM IngredientInventory WHERE globalItemId IN (${placeholders})`).run(...ids).changes,
    };
    const gardensReset = db.prepare(`UPDATE GardenPlot SET ingredientId = 0 WHERE ingredientId IN (${placeholders})`).run(...ids).changes;

    let profilesDebited = 0;
    let coinsDebited = 0;
    if (revokeOpenedCoins) {
      const findProfile = db.prepare('SELECT credits FROM UserProfile WHERE id = ?');
      const debit = db.prepare('UPDATE UserProfile SET credits = MAX(0, credits - ?) WHERE id = ?');
      for (const [profileId, amount] of plan.creditRevocations) {
        if (amount <= 0) continue;
        const before = findProfile.get(profileId);
        if (!before) continue;
        profilesDebited += debit.run(amount, profileId).changes;
        coinsDebited += Math.min(Number(before.credits), amount);
      }
    }
    return { mailsDeleted, rowsDeleted, gardensReset, profilesDebited, coinsDebited };
  })();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  if (options.revokeOpenedCoins && !options.apply) throw new Error('--revoke-opened-coins requires --apply.');

  const dbPath = resolveDatabasePath(options.database);
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  const itemIds = new Set(options.itemIds);
  const coinValues = readCoinValues(itemIds);
  const missingValues = [...itemIds].filter((id) => !coinValues.has(id));
  if (options.revokeOpenedCoins && missingValues.length > 0) {
    throw new Error(`Cannot revoke coins: item ids are not fanPageFeed coin rewards in perk.xml: ${missingValues.join(', ')}`);
  }

  const db = new Database(dbPath, { readonly: !options.apply });
  const plan = analyze(db, itemIds, coinValues);
  const affectedProfiles = new Set(plan.mails.map((mail) => mail.recipientProfileId));
  const openedMails = plan.mails.filter((mail) => mail.read).length;
  const potentialCoins = [...plan.creditRevocations.values()].reduce((sum, value) => sum + value, 0);

  console.log(`Database: ${dbPath}`);
  console.log(`Target item ids: ${[...itemIds].join(', ')}`);
  console.log(`Matching gift mails: ${plan.mails.length} across ${affectedProfiles.size} profiles (${openedMails} opened)`);
  console.log(`Stored reward rows: ${Object.entries(plan.tableCounts).map(([table, count]) => `${table} ${count}`).join(', ')}`);
  console.log(`Opened-mail coin value: ${potentialCoins}`);

  if (!options.apply) {
    db.close();
    console.log('\nRead-only: nothing changed. Re-run with --apply after stopping the server.');
    return;
  }

  const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await db.backup(backupPath);
  const result = applyPlan(db, plan, itemIds, options.revokeOpenedCoins);
  db.close();
  console.log(`Backup: ${backupPath}`);
  console.log(`Removed ${result.mailsDeleted} mails, ${Object.values(result.rowsDeleted).reduce((sum, count) => sum + count, 0)} stored item rows, and reset ${result.gardensReset} garden plots.`);
  if (options.revokeOpenedCoins) console.log(`Debited ${result.coinsDebited} coins across ${result.profilesDebited} profiles.`);
  else if (openedMails > 0) console.log('Opened gifts were found; coins were not changed. Review them or restore the backup before running with --revoke-opened-coins.');
}

module.exports = { parseArgs, readCoinValues, readItemIds, analyze, applyPlan };

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
