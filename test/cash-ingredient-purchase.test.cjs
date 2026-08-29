const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.cash-ingredient-purchase-test-${process.pid}.db`;
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
const { purchaseCashIngredients } = require('../dist/db/rpc-store.js');

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('PF-cash ingredient purchases credit the XML ingredient ids atomically', async () => {
  const networkUid = '940000001';
  const profileId = `facebook:${networkUid}`;
  const account = { networkUid, playfishUid: Number(networkUid), username: 'cashingredient' };
  await prisma.userProfile.create({ data: {
    id: profileId,
    networkUid,
    playfishUid: account.playfishUid,
    firstName: 'Cash',
    fullName: 'Cash Ingredient',
    restaurantName: 'Cash Ingredient Restaurant',
    cashBalance: 20,
  } });

  const result = await purchaseCashIngredients(account, [
    'jn7oj0vkTbuJkKA5QjzGda', // Beans, id 4000004, PF cash 4
    'dn5yovNc6QRAjcTpMYvSva', // Mushroom, id 4000024, PF cash 6
  ]);

  assert.deepEqual(result, { status: 0, balance: 10 });
  const ingredients = await prisma.ingredientInventory.findMany({
    where: { userProfileId: profileId },
    orderBy: { globalItemId: 'asc' },
  });
  assert.deepEqual(ingredients
    .filter(({ globalItemId }) => globalItemId === 4000004 || globalItemId === 4000024)
    .map(({ globalItemId, number }) => ({ globalItemId, number })), [
    { globalItemId: 4000004, number: 1 },
    { globalItemId: 4000024, number: 1 },
  ]);
  assert.equal(ingredients.some(({ globalItemId }) => globalItemId < 4_000_000), false, 'opaque hash digits never become inventory ids');
  assert.equal(await prisma.cashTransaction.count({ where: { userProfileId: profileId, kind: 'purchaseCashItemIngredientsV2' } }), 1);
});
