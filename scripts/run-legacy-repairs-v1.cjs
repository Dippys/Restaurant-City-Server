'use strict';

/** Explicit, idempotent replacement for the legacy data scans formerly run on every boot. */
async function main() {
  const { prisma } = require('../dist/db/client.js');
  const { repairLegacyCashIngredientPurchases } = require('../dist/db/legacy-cash-ingredient-repair.js');
  const { repairMisclassifiedRestaurantEntitlements } = require('../dist/db/special-entitlement-repair.js');
  const { repairLegacyAdminCoinMailRewards } = require('../dist/db/legacy-coin-mail-repair.js');
  try {
    const cash = await repairLegacyCashIngredientPurchases();
    console.log(`Legacy PF-cash ingredient repair: ${cash.transactions} transaction(s), ${cash.purchasedUnits} unit(s), ${cash.profiles} profile(s), ${cash.adjustedRows} inventory row(s), ${cash.skippedTransactions} skipped.`);

    const entitlements = await repairMisclassifiedRestaurantEntitlements();
    console.log(`Restaurant entitlement repair: ${entitlements.restoredItems} item(s), ${entitlements.profiles} profile(s), ${entitlements.removedInventoryUnits} inventory unit(s), ${entitlements.refundedCoins} coins, ${entitlements.refundedCash} PF cash.`);

    const mail = await repairLegacyAdminCoinMailRewards();
    console.log(`Legacy coin-mail repair: ${mail.credits} coin(s), ${mail.mails} mail(s), ${mail.profiles} profile(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { main };
