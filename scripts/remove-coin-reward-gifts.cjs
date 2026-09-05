#!/usr/bin/env node
'use strict';

// Audits every mailbox row against the server's type, sender, and catalog
// rules. Read-only by default. --apply creates a consistent SQLite backup,
// deletes invalid mail, reverses one server-granted item for each invalid
// type-4 gift, and removes feed-reward tokens that can never be inventory.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DATA_FILES = ['front.xml', 'restaurant.xml', 'ingredient.xml', 'recipe.xml', 'perk.xml', 'avatar.xml', 'appointment.xml'];
const SYSTEM_UID = '1';
const SOCIAL_MESSAGES = new Map([
  [10, 'Food King reward claimed through RC Reborn.'],
  [11, 'promotion reward claimed through RC Reborn.'],
  [13, 'specialDay reward claimed through RC Reborn.'],
]);

function resolveDatabasePath(flagPath) {
  if (flagPath) return path.resolve(flagPath);
  if (process.env.RC_DB_PATH) return path.resolve(process.env.RC_DB_PATH);
  return path.resolve(__dirname, '..', 'dev.db');
}

function parseArgs(argv) {
  const options = { apply: false, database: '', forcedItemIds: [], keepMailIds: [], revokeOpenedRewards: false, verbose: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--database') options.database = String(argv[++index] || '');
    else if (arg === '--items') {
      options.forcedItemIds = String(argv[++index] || '').split(',').map((value) => Number(value.trim())).filter(Number.isInteger);
    } else if (arg === '--keep-mail') {
      options.keepMailIds = String(argv[++index] || '').split(',').map((value) => Number(value.trim())).filter(Number.isInteger);
    } else if (arg === '--revoke-opened-rewards' || arg === '--revoke-opened-coins') options.revokeOpenedRewards = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/remove-coin-reward-gifts.cjs [--database PATH]
  node scripts/remove-coin-reward-gifts.cjs --apply [--database PATH] [--revoke-opened-rewards]

Options:
  --apply                    Back up the database, then repair invalid mail
  --database PATH            SQLite file (default: RC_DB_PATH or dev.db)
  --items IDS                Additionally reject these attached item ids
  --keep-mail IDS            Exempt reviewed mail row ids (comma-separated)
  --revoke-opened-rewards    Debit opened invalid coin/cash/popularity rewards
  --revoke-opened-coins      Backward-compatible alias for the option above
  --verbose                  Print up to 100 invalid-mail details
  -h, --help                 Show this help

Stop the server before applying. Without --apply this command only reports the plan.`);
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) result[match[1]] = match[2];
  return result;
}

function buildCatalog() {
  const items = new Map();
  const employeeSnacks = new Set();
  const dataDir = path.resolve(__dirname, '..', 'public', 'data');
  for (const file of DATA_FILES) {
    let xml = '';
    try { xml = fs.readFileSync(path.join(dataDir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, ''); } catch { continue; }
    for (const match of xml.matchAll(/<item\b([^>]*)\/?\s*>/g)) {
      const attrs = attributes(match[1]);
      const id = Number(attrs.id);
      if (Number.isInteger(id) && id > 0) items.set(id, attrs);
    }
    if (file === 'perk.xml') {
      const employeeGroup = xml.match(/<group\b[^>]*\bname="Employee"[^>]*>([\s\S]*?)<\/group>/)?.[1] ?? '';
      for (const match of employeeGroup.matchAll(/<item\b([^>]*)\/?\s*>/g)) {
        const id = Number(attributes(match[1]).id);
        if (Number.isInteger(id)) employeeSnacks.add(id);
      }
    }
  }
  return { items, employeeSnacks };
}

function readItemIds(json) {
  try {
    const parsed = JSON.parse(json || '[]');
    if (!Array.isArray(parsed) || parsed.some((id) => !Number.isInteger(id) || id <= 0)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isGiftable(attrs) {
  const id = Number(attrs?.id);
  return Boolean(attrs)
    && attrs.invisible !== 'true'
    && !([602, 603].includes(Math.floor(id / 10_000)) && attrs.fanPageFeed === 'true')
    && !/\bnotGiftable\b/.test(attrs.type ?? '');
}

function validCurrencyMessage(message) {
  const text = message.startsWith('PFC:') ? message.slice(4) : message;
  const amount = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(amount) && amount > 0 && amount <= 999_999_999;
}

function invalidReason(mail, catalog, trustedSenders, forcedItemIds) {
  const ids = readItemIds(mail.globalItemIdsJson);
  if (ids === null) return 'malformed-item-list';
  if (ids.some((id) => forcedItemIds.has(id))) return 'operator-forced-item';
  if (ids.some((id) => !catalog.items.has(id))) return 'unknown-item';
  const trusted = trustedSenders.has(String(mail.senderNetworkUid));
  const ingredientIds = () => ids.every((id) => Math.floor(id / 1_000_000) === 4);
  if (!trusted && mail.recipientProfileId === `facebook:${mail.senderNetworkUid}` && [1, 4, 6].includes(Number(mail.type))) {
    return 'self-sent-player-mail';
  }

  switch (Number(mail.type)) {
    case 1:
      return ids.length === 0 && mail.message.trim() ? null : 'invalid-player-message';
    case 2:
      if (!trusted) return 'unauthorized-system-mail';
      return ids.length === 0 ? null : 'invalid-quiz-mail';
    case 3:
      if (!trusted) return 'unauthorized-system-mail';
      return ids.length === 0 && mail.message.trim() ? null : 'invalid-system-message';
    case 4:
      return ids.length === 1 && isGiftable(catalog.items.get(ids[0])) ? null : 'invalid-gift-item';
    case 5:
      if (!trusted) return 'unauthorized-system-mail';
      return ids.length >= 1 && ids.length <= 5 && ingredientIds() ? null : 'invalid-daily-ingredients';
    case 6:
    case 8:
      return ids.length === 2 && ingredientIds() ? null : 'invalid-trade-mail';
    case 7:
      if (!trusted) return 'unauthorized-currency-mail';
      return ids.length === 0 && validCurrencyMessage(mail.message) ? null : 'invalid-currency-mail';
    case 9:
      return ids.length === 1 && catalog.employeeSnacks.has(ids[0]) ? null : 'invalid-employee-snack';
    case 10:
      if (!trusted && mail.message !== SOCIAL_MESSAGES.get(10)) return 'unauthorized-food-king-mail';
      return ids.length === 1 && catalog.items.get(ids[0])?.foodKingFeed === 'true' ? null : 'invalid-food-king-reward';
    case 11:
      if (!trusted && mail.message !== SOCIAL_MESSAGES.get(11)) return 'unauthorized-promotion-mail';
      return ids.length === 1 ? null : 'invalid-fan-page-reward';
    case 13: {
      const social = mail.message === SOCIAL_MESSAGES.get(13);
      if (!trusted && !social) return 'unauthorized-special-mail';
      if (social) return ids.length === 1 ? null : 'invalid-special-reward';
      const themed = ids.length === 1 && ['CHRISTMAS', 'VALENTINES', 'CHINESE_NEW_YEAR'].includes(mail.message);
      const startup = ids.length === 0 && mail.message === '3MillionFan';
      return themed || startup ? null : 'invalid-special-reward';
    }
    default:
      return 'unsupported-mail-type';
  }
}

function rewardDeltas(mail, catalog) {
  if (!mail.read) return { credits: 0, cash: 0, demand: 0 };
  const ids = readItemIds(mail.globalItemIdsJson) ?? [];
  let credits = 0;
  let cash = 0;
  let demand = 0;
  if (Number(mail.type) === 7 && validCurrencyMessage(mail.message)) {
    const amount = Number(mail.message.startsWith('PFC:') ? mail.message.slice(4) : mail.message);
    if (mail.message.startsWith('PFC:')) cash += amount;
    else credits += amount;
  }
  if ([4, 10, 11, 13].includes(Number(mail.type))) {
    for (const id of ids) {
      const attrs = catalog.items.get(id);
      if (attrs?.fanPageFeed !== 'true') continue;
      const subtype = Math.floor(id / 10_000);
      if (subtype === 602) credits += Number(attrs.cost) || 0;
      if (subtype === 603) demand += Number(attrs.value) || 0;
    }
  }
  return { credits, cash, demand };
}

function analyze(db, catalog, forcedItemIds, keepMailIds = new Set()) {
  const trustedSenders = new Set([SYSTEM_UID]);
  for (const row of db.prepare("SELECT networkUid FROM Account WHERE role = 'ADMIN'").all()) trustedSenders.add(String(row.networkUid));

  const invalid = [];
  const reasons = {};
  const rewardRevocations = new Map();
  const rows = db.prepare('SELECT id, senderNetworkUid, recipientProfileId, globalItemIdsJson, message, read, type FROM Mail').all();
  for (const mail of rows) {
    if (keepMailIds.has(Number(mail.id))) continue;
    const reason = invalidReason(mail, catalog, trustedSenders, forcedItemIds);
    if (!reason) continue;
    const entry = {
      ...mail,
      reason,
      itemIds: readItemIds(mail.globalItemIdsJson) ?? [],
      trustedSender: trustedSenders.has(String(mail.senderNetworkUid)),
    };
    invalid.push(entry);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    const delta = rewardDeltas(mail, catalog);
    const current = rewardRevocations.get(mail.recipientProfileId) ?? { credits: 0, cash: 0, demand: 0 };
    rewardRevocations.set(mail.recipientProfileId, {
      credits: current.credits + delta.credits,
      cash: current.cash + delta.cash,
      demand: current.demand + delta.demand,
    });
  }

  const forbiddenStoredIds = new Set([...catalog.items]
    .filter(([id, attrs]) => [602, 603].includes(Math.floor(id / 10_000)) && attrs.fanPageFeed === 'true')
    .map(([id]) => id));
  return { invalid, reasons, rewardRevocations, forbiddenStoredIds };
}

function decrementGrantedItem(db, profileId, itemId) {
  if (!Number.isInteger(itemId) || itemId <= 0) return false;
  const table = Math.floor(itemId / 1_000_000) === 4 ? 'IngredientInventory' : 'InventoryItem';
  const row = db.prepare(`SELECT id, number FROM ${table} WHERE userProfileId = ? AND globalItemId = ?`).get(profileId, itemId);
  if (row) {
    if (row.number > 1) db.prepare(`UPDATE ${table} SET number = number - 1 WHERE id = ?`).run(row.id);
    else db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
    return true;
  }
  const placed = db.prepare('SELECT id FROM OwnedItem WHERE userProfileId = ? AND globalItemId = ? ORDER BY rowid DESC LIMIT 1').get(profileId, itemId);
  if (!placed) return false;
  db.prepare('DELETE FROM OwnedItem WHERE id = ?').run(placed.id);
  return true;
}

function deleteForbiddenStoredItems(db, ids) {
  if (ids.size === 0) return 0;
  const placeholders = [...ids].map(() => '?').join(',');
  const values = [...ids];
  let changed = 0;
  for (const table of ['InventoryItem', 'OwnedItem', 'IngredientInventory']) {
    changed += db.prepare(`DELETE FROM ${table} WHERE globalItemId IN (${placeholders})`).run(...values).changes;
  }
  changed += db.prepare(`UPDATE GardenPlot SET ingredientId = 0 WHERE ingredientId IN (${placeholders})`).run(...values).changes;
  return changed;
}

function applyPlan(db, plan, revokeOpenedRewards) {
  return db.transaction(() => {
    const deleteMail = db.prepare('DELETE FROM Mail WHERE id = ?');
    let mailsDeleted = 0;
    let grantsReversed = 0;
    for (const mail of plan.invalid) {
      // sendMail grants only the first item of a type-4 payload.
      if (Number(mail.type) === 4 && decrementGrantedItem(db, mail.recipientProfileId, mail.itemIds[0])) grantsReversed += 1;
      // Trusted admin/system reward paths pre-grant attached items. Reverse
      // those too, except 602/603 popup tokens which were never item storage.
      if (mail.trustedSender && [5, 9, 10, 11, 13].includes(Number(mail.type))) {
        for (const itemId of mail.itemIds) {
          if ([602, 603].includes(Math.floor(itemId / 10_000))) continue;
          if (decrementGrantedItem(db, mail.recipientProfileId, itemId)) grantsReversed += 1;
        }
      }
      mailsDeleted += deleteMail.run(mail.id).changes;
    }
    const forbiddenRowsDeleted = deleteForbiddenStoredItems(db, plan.forbiddenStoredIds);

    let profilesDebited = 0;
    const totals = { credits: 0, cash: 0, demand: 0 };
    if (revokeOpenedRewards) {
      const find = db.prepare('SELECT credits, cashBalance, demandPoint FROM UserProfile WHERE id = ?');
      const update = db.prepare('UPDATE UserProfile SET credits = MAX(0, credits - ?), cashBalance = MAX(0, cashBalance - ?), demandPoint = MAX(0, demandPoint - ?) WHERE id = ?');
      for (const [profileId, amount] of plan.rewardRevocations) {
        if (amount.credits + amount.cash + amount.demand <= 0) continue;
        const before = find.get(profileId);
        if (!before) continue;
        profilesDebited += update.run(amount.credits, amount.cash, amount.demand, profileId).changes;
        totals.credits += Math.min(Number(before.credits), amount.credits);
        totals.cash += Math.min(Number(before.cashBalance), amount.cash);
        totals.demand += Math.min(Number(before.demandPoint), amount.demand);
      }
    }
    return { mailsDeleted, grantsReversed, forbiddenRowsDeleted, profilesDebited, totals };
  })();
}

async function main() {
  if (process.env.DATABASE_URL && !process.argv.slice(2).includes('--database')) {
    await require('./repair-mail-integrity-postgresql.cjs').main();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  if (options.revokeOpenedRewards && !options.apply) throw new Error('--revoke-opened-rewards requires --apply.');
  const dbPath = resolveDatabasePath(options.database);
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

  const catalog = buildCatalog();
  const db = new Database(dbPath, { readonly: !options.apply });
  const plan = analyze(db, catalog, new Set(options.forcedItemIds), new Set(options.keepMailIds));
  const profiles = new Set(plan.invalid.map((mail) => mail.recipientProfileId));
  const opened = plan.invalid.filter((mail) => mail.read).length;
  console.log(`Database: ${dbPath}`);
  console.log(`Catalog items: ${catalog.items.size}; forbidden stored feed rewards: ${plan.forbiddenStoredIds.size}`);
  console.log(`Invalid mails: ${plan.invalid.length} across ${profiles.size} profiles (${opened} opened)`);
  for (const [reason, count] of Object.entries(plan.reasons).sort()) console.log(`  ${reason}: ${count}`);
  if (options.verbose) {
    for (const mail of plan.invalid.slice(0, 100)) {
      console.log(`  mail ${mail.id}: type ${mail.type}, ${mail.reason}, sender ${mail.senderNetworkUid}, recipient ${mail.recipientProfileId}, items [${mail.itemIds.join(',')}]${mail.read ? ', opened' : ''}`);
    }
    if (plan.invalid.length > 100) console.log(`  ... and ${plan.invalid.length - 100} more invalid mails`);
  }

  if (!options.apply) {
    db.close();
    console.log('\nRead-only: nothing changed. Re-run with --apply after stopping the server.');
    return;
  }
  const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await db.backup(backupPath);
  const result = applyPlan(db, plan, options.revokeOpenedRewards);
  db.close();
  console.log(`Backup: ${backupPath}`);
  console.log(`Removed ${result.mailsDeleted} invalid mails, reversed ${result.grantsReversed} gift grants, and removed/reset ${result.forbiddenRowsDeleted} forbidden stored reward rows.`);
  if (options.revokeOpenedRewards) {
    console.log(`Debited ${result.totals.credits} coins, ${result.totals.cash} PF cash, and ${result.totals.demand} demand points across ${result.profilesDebited} profiles.`);
  } else if (opened > 0) {
    console.log('Opened invalid reward mail was found; balances were not changed. Review the backup before using --revoke-opened-rewards.');
  }
}

module.exports = { parseArgs, buildCatalog, readItemIds, invalidReason, rewardDeltas, analyze, applyPlan };

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
