#!/usr/bin/env node
'use strict';

const { Client } = require('pg');
const {
  parseArgs, buildCatalog, readItemIds, invalidReason, rewardDeltas,
} = require('./remove-coin-reward-gifts.cjs');

const SYSTEM_UID = '1';
const BATCH_SIZE = 5000;

function forbiddenIds(catalog) {
  return [...catalog.items]
    .filter(([id, attrs]) => [602, 603].includes(Math.floor(id / 10_000)) && attrs.fanPageFeed === 'true')
    .map(([id]) => id);
}

async function decrementGrantedItem(client, profileId, itemId) {
  if (!Number.isInteger(itemId) || itemId <= 0) return false;
  const table = Math.floor(itemId / 1_000_000) === 4 ? 'IngredientInventory' : 'InventoryItem';
  const found = await client.query(`SELECT id, number FROM "${table}" WHERE "userProfileId" = $1 AND "globalItemId" = $2 LIMIT 1`, [profileId, itemId]);
  if (found.rowCount) {
    const row = found.rows[0];
    if (row.number > 1) await client.query(`UPDATE "${table}" SET number = number - 1 WHERE id = $1`, [row.id]);
    else await client.query(`DELETE FROM "${table}" WHERE id = $1`, [row.id]);
    return true;
  }
  const placed = await client.query('SELECT id FROM "OwnedItem" WHERE "userProfileId" = $1 AND "globalItemId" = $2 ORDER BY "createdAt" DESC, id DESC LIMIT 1', [profileId, itemId]);
  if (!placed.rowCount) return false;
  await client.query('DELETE FROM "OwnedItem" WHERE id = $1', [placed.rows[0].id]);
  return true;
}

async function deleteForbiddenStoredItems(client, ids) {
  if (!ids.length) return 0;
  let changed = 0;
  for (const table of ['InventoryItem', 'OwnedItem', 'IngredientInventory']) {
    const result = await client.query(`DELETE FROM "${table}" WHERE "globalItemId" = ANY($1::integer[])`, [ids]);
    changed += result.rowCount || 0;
  }
  const plots = await client.query('UPDATE "GardenPlot" SET "ingredientId" = 0 WHERE "ingredientId" = ANY($1::integer[])', [ids]);
  return changed + (plots.rowCount || 0);
}

async function scan(client, options, catalog, trustedSenders, onInvalid) {
  const reasons = {};
  const profiles = new Set();
  let invalidCount = 0;
  let opened = 0;
  let lastId = 0;
  let verbosePrinted = 0;
  const keep = new Set(options.keepMailIds);
  const forced = new Set(options.forcedItemIds);
  while (true) {
    const page = await client.query(`
      SELECT id, "senderNetworkUid", "recipientProfileId", "globalItemIdsJson", message, read, type
        FROM "Mail" WHERE id > $1 ORDER BY id LIMIT $2`, [lastId, BATCH_SIZE]);
    if (!page.rowCount) break;
    for (const mail of page.rows) {
      lastId = Number(mail.id);
      if (keep.has(lastId)) continue;
      const reason = invalidReason(mail, catalog, trustedSenders, forced);
      if (!reason) continue;
      const itemIds = readItemIds(mail.globalItemIdsJson) ?? [];
      const entry = { ...mail, reason, itemIds, trustedSender: trustedSenders.has(String(mail.senderNetworkUid)) };
      invalidCount += 1;
      if (mail.read) opened += 1;
      profiles.add(mail.recipientProfileId);
      reasons[reason] = (reasons[reason] || 0) + 1;
      if (options.verbose && verbosePrinted < 100) {
        console.log(`  mail ${mail.id}: type ${mail.type}, ${reason}, sender ${mail.senderNetworkUid}, recipient ${mail.recipientProfileId}, items [${itemIds.join(',')}]${mail.read ? ', opened' : ''}`);
        verbosePrinted += 1;
      }
      await onInvalid(entry);
    }
  }
  return { reasons, profiles: profiles.size, invalidCount, opened };
}

async function revokeReward(client, profileId, delta) {
  if (delta.credits + delta.cash + delta.demand <= 0) return { changed: 0, credits: 0, cash: 0, demand: 0 };
  const beforeResult = await client.query('SELECT credits, "cashBalance", "demandPoint" FROM "UserProfile" WHERE id = $1 FOR UPDATE', [profileId]);
  if (!beforeResult.rowCount) return { changed: 0, credits: 0, cash: 0, demand: 0 };
  const before = beforeResult.rows[0];
  await client.query(`
    UPDATE "UserProfile"
       SET credits = GREATEST(0, credits - $1),
           "cashBalance" = GREATEST(0, "cashBalance" - $2),
           "demandPoint" = GREATEST(0, "demandPoint" - $3)
     WHERE id = $4`,
  [delta.credits, delta.cash, delta.demand, profileId]);
  return {
    changed: 1,
    credits: Math.min(Number(before.credits), delta.credits),
    cash: Math.min(Number(before.cashBalance), delta.cash),
    demand: Math.min(Number(before.demandPoint), delta.demand),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('PostgreSQL mail repair: DATABASE_URL=postgresql://... npm run repair:mail-integrity -- [--apply] [--revoke-opened-rewards] [--verbose]');
    return;
  }
  if (options.database) throw new Error('--database selects the SQLite repair; use DATABASE_URL for PostgreSQL.');
  if (options.revokeOpenedRewards && !options.apply) throw new Error('--revoke-opened-rewards requires --apply.');
  const url = process.env.DATABASE_URL || '';
  if (!/^postgres(?:ql)?:\/\//i.test(url)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  const catalog = buildCatalog();
  const client = new Client({ connectionString: url, application_name: 'restaurant-city-mail-integrity' });
  await client.connect();
  let committed = false;
  try {
    if (options.apply) {
      await client.query('BEGIN');
      await client.query('LOCK TABLE "Mail" IN SHARE ROW EXCLUSIVE MODE');
    }
    const admins = await client.query('SELECT "networkUid" FROM "Account" WHERE role = \'ADMIN\'');
    const trusted = new Set([SYSTEM_UID, ...admins.rows.map((row) => String(row.networkUid))]);
    const totals = { mailsDeleted: 0, grantsReversed: 0, profilesDebited: 0, credits: 0, cash: 0, demand: 0 };
    const report = await scan(client, options, catalog, trusted, async (mail) => {
      if (!options.apply) return;
      if (Number(mail.type) === 4 && await decrementGrantedItem(client, mail.recipientProfileId, mail.itemIds[0])) totals.grantsReversed += 1;
      if (mail.trustedSender && [5, 9, 10, 11, 13].includes(Number(mail.type))) {
        for (const id of mail.itemIds) {
          if (![602, 603].includes(Math.floor(id / 10_000)) && await decrementGrantedItem(client, mail.recipientProfileId, id)) totals.grantsReversed += 1;
        }
      }
      if (options.revokeOpenedRewards) {
        const revoked = await revokeReward(client, mail.recipientProfileId, rewardDeltas(mail, catalog));
        totals.profilesDebited += revoked.changed;
        totals.credits += revoked.credits; totals.cash += revoked.cash; totals.demand += revoked.demand;
      }
      const deleted = await client.query('DELETE FROM "Mail" WHERE id = $1', [mail.id]);
      totals.mailsDeleted += deleted.rowCount || 0;
    });
    console.log(`Database: PostgreSQL ${new URL(url).host}/${new URL(url).pathname.replace(/^\//, '')}`);
    console.log(`Catalog items: ${catalog.items.size}; forbidden stored feed rewards: ${forbiddenIds(catalog).length}`);
    console.log(`Invalid mails: ${report.invalidCount} across ${report.profiles} profiles (${report.opened} opened)`);
    for (const [reason, count] of Object.entries(report.reasons).sort()) console.log(`  ${reason}: ${count}`);
    if (!options.apply) {
      console.log('\nRead-only: nothing changed. Re-run with --apply after stopping the server.');
      return;
    }
    const forbiddenRowsDeleted = await deleteForbiddenStoredItems(client, forbiddenIds(catalog));
    await client.query('COMMIT');
    committed = true;
    console.log(`Removed ${totals.mailsDeleted} invalid mails, reversed ${totals.grantsReversed} gift grants, and removed/reset ${forbiddenRowsDeleted} forbidden stored reward rows.`);
    if (options.revokeOpenedRewards) console.log(`Debited ${totals.credits} coins, ${totals.cash} PF cash, and ${totals.demand} demand points (${totals.profilesDebited} reward adjustments).`);
    else if (report.opened) console.log('Opened invalid reward mail was found; balances were not changed. Review before using --revoke-opened-rewards.');
  } finally {
    if (options.apply && !committed) await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

module.exports = { main, scan, decrementGrantedItem };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
