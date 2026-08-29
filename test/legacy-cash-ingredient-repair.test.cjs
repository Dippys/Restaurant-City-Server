const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.legacy-cash-ingredient-repair-test-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH;
const push = spawnSync(
  process.execPath,
  [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`],
  { cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8' },
);
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;

const { prisma } = require('../dist/db/client.js');
const {
  CURRENT_CASH_INGREDIENT_KIND,
  LEGACY_CASH_INGREDIENT_KIND,
  REPAIRED_CASH_INGREDIENT_KIND,
  repairLegacyCashIngredientPurchases,
} = require('../dist/db/legacy-cash-ingredient-repair.js');

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('legacy PF-cash ingredient credits are repaired once with a recovery snapshot', async () => {
  const networkUid = '950000001';
  const profileId = `facebook:${networkUid}`;
  await prisma.userProfile.create({ data: {
    id: profileId, networkUid, playfishUid: Number(networkUid), firstName: 'Legacy', fullName: 'Legacy Cash',
    restaurantName: 'Legacy Cash Restaurant',
    ingredients: { create: [
      { id: `${profileId}:ingredient:5`, globalItemId: 5, number: 1, isLocked: true },
      { id: `${profileId}:ingredient:4000000`, globalItemId: 4000000, number: 1, isLocked: true },
      { id: `${profileId}:ingredient:4000024`, globalItemId: 4000024, number: 2, isLocked: false },
    ] },
    cashTransactions: { create: [
      { kind: LEGACY_CASH_INGREDIENT_KIND, token: 'dn5yovNc6QRAjcTpMYvSva', amount: -6, balanceAfter: 244, createdAtUnix: 1 },
      { kind: LEGACY_CASH_INGREDIENT_KIND, token: 'hbvbtiywjfbtGr.DGin.uq', amount: -3, balanceAfter: 241, createdAtUnix: 2 },
      { kind: CURRENT_CASH_INGREDIENT_KIND, token: 'jn7oj0vkTbuJkKA5QjzGda', amount: -4, balanceAfter: 237, createdAtUnix: 3 },
    ] },
  } });

  const first = await repairLegacyCashIngredientPurchases();
  assert.deepEqual(first, { profiles: 1, transactions: 2, purchasedUnits: 2, adjustedRows: 4, skippedTransactions: 0 });
  const ingredients = await prisma.ingredientInventory.findMany({ where: { userProfileId: profileId }, orderBy: { globalItemId: 'asc' } });
  assert.deepEqual(ingredients.map(({ globalItemId, number, isLocked }) => ({ globalItemId, number, isLocked })), [
    { globalItemId: 4000005, number: 1, isLocked: true },
    { globalItemId: 4000024, number: 3, isLocked: true },
  ]);
  assert.equal(await prisma.cashTransaction.count({ where: { userProfileId: profileId, kind: REPAIRED_CASH_INGREDIENT_KIND } }), 2);
  assert.equal(await prisma.cashTransaction.count({ where: { userProfileId: profileId, kind: CURRENT_CASH_INGREDIENT_KIND } }), 1);
  assert.equal(await prisma.profileSnapshot.count({ where: { networkUid, reason: 'AUTO_BEFORE_CASH_INGREDIENT_REPAIR' } }), 1);

  assert.deepEqual(await repairLegacyCashIngredientPurchases(), {
    profiles: 0, transactions: 0, purchasedUnits: 0, adjustedRows: 0, skippedTransactions: 0,
  });
  assert.equal(await prisma.profileSnapshot.count({ where: { networkUid, reason: 'AUTO_BEFORE_CASH_INGREDIENT_REPAIR' } }), 1);
});
