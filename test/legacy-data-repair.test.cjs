const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

// fix-legacy-data.cjs: one-stop repair of provable legacy damage.

const testDbName = `.legacy-data-test-${process.pid}.db`;
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
  buildCatalog, fixOwnedKeys, fixSaveFactDeltas, fixDuplicatePlacements, fixFacadeSingletons, deleteUnknownItems, analyze,
} = require('../scripts/fix-legacy-data.cjs');

const uid = '950000001';
const pid = `facebook:${uid}`;

async function seedLegacyFixture() {
  await prisma.userProfile.create({ data: {
    id: pid, networkUid: uid, playfishUid: Number(uid), firstName: 'Legacy', fullName: 'Legacy Chef',
    restaurantName: "Legacy's Restaurant", demandPoint: 120,
  } });
  await prisma.ownedItem.createMany({ data: [
    // 1. id/serverId mismatch
    { id: `${pid}:owned:-8`, userProfileId: pid, serverId: 1, globalItemId: 3020017, positionX: 0, positionY: 0, data: 0, roomIndex: 0 },
    // 2. exact-position duplicate (bookshelves): newest is 3020097 at (1,6)
    { id: `${pid}:owned:10`, userProfileId: pid, serverId: 10, globalItemId: 3020097, positionX: 1, positionY: 6, data: 0, roomIndex: 1, updatedAt: new Date('2026-08-25T00:00:00Z'), createdAt: new Date('2026-08-25T00:00:00Z') },
    { id: `${pid}:owned:11`, userProfileId: pid, serverId: 11, globalItemId: 3020097, positionX: 1, positionY: 6, data: 0, roomIndex: 1, updatedAt: new Date('2026-08-26T00:00:00Z'), createdAt: new Date('2026-08-26T00:00:00Z') },
    // 3. stackable pair at the same tile: must be preserved
    { id: `${pid}:owned:20`, userProfileId: pid, serverId: 20, globalItemId: 3020003, positionX: 1, positionY: 1, data: 0, roomIndex: 0, updatedAt: new Date('2026-08-24T00:00:00Z'), createdAt: new Date('2026-08-24T00:00:00Z') },
    { id: `${pid}:owned:21`, userProfileId: pid, serverId: 21, globalItemId: 3020003, positionX: 1, positionY: 1, data: 0, roomIndex: 0, updatedAt: new Date('2026-08-25T00:00:00Z'), createdAt: new Date('2026-08-25T00:00:00Z') },
    // 4. facade singleton duplicates: two group-201 doors
    { id: `${pid}:owned:30`, userProfileId: pid, serverId: 30, globalItemId: 2010012, positionX: 0, positionY: 0, data: 0, roomIndex: 0, updatedAt: new Date('2026-08-24T00:00:00Z'), createdAt: new Date('2026-08-24T00:00:00Z') },
    { id: `${pid}:owned:31`, userProfileId: pid, serverId: 31, globalItemId: 2010001, positionX: 5, positionY: 5, data: 0, roomIndex: 0, updatedAt: new Date('2026-08-26T00:00:00Z'), createdAt: new Date('2026-08-26T00:00:00Z') },
    // 5. unknown junk id
    { id: `${pid}:owned:40`, userProfileId: pid, serverId: 40, globalItemId: 9999999, positionX: 0, positionY: 0, data: 0, roomIndex: 0 },
  ] });
  await prisma.inventoryItem.create({ data: { id: `${pid}:inventory:0`, userProfileId: pid, globalItemId: 0, number: 34, isSelected: true } });
  const factRow = (saveVersion, clientTime, clientDeltaSeconds, createdAt) => ({
    networkUid: uid, saveVersion, clientTime, previousClientTime: 60000,
    serverDeltaSeconds: 60, clientDeltaSeconds, previousCredits: 0, credits: 0, creditDelta: 0,
    previousGourmet: 0, gourmetPoint: 0, gourmetDelta: 0, previousLevel: 1, userLevel: 1,
    actionCount: 1, unknownActionCount: 0, actionCountsJson: '{}', placedItems: 1, inventoryUnits: 1,
    ingredientUnits: 0, employeeCount: 0, gardenPlotCount: 0, selectedRecipeCount: 0, createdAt,
  });
  await prisma.profileSaveFact.create({ data: factRow(1, 60000, 0, new Date('2026-08-27T00:00:00Z')) });
  await prisma.profileSaveFact.create({ data: factRow(2, 120300, 60316, new Date('2026-08-27T00:01:00Z')) });
}

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('fix-legacy-data repairs every provable legacy problem and preserves stackable stacks', async () => {
  await seedLegacyFixture();
  const db = new Database(testDbPath);
  try {
    const catalog = buildCatalog();
    assert.equal(catalog.stackable.has(3020003), true);
    assert.equal(catalog.known.has(2010001), true);

    assert.deepEqual(fixOwnedKeys(db), { repaired: 1 });
    assert.deepEqual(fixSaveFactDeltas(db), { updated: 1 });
    assert.deepEqual(fixDuplicatePlacements(db, catalog.stackable), { groupsFixed: 1, copiesReturned: 1 });
    assert.deepEqual(fixFacadeSingletons(db), { groupsFixed: 1, copiesReturned: 1 });
    assert.deepEqual(deleteUnknownItems(db, catalog.known), { ownedDeleted: 1, inventoryDeleted: 1, ingredientDeleted: 0, gardenReset: 0 });

    const plan = analyze(db, catalog);
    assert.equal(plan.keyMismatches, 0);
    assert.equal(plan.implausibleFacts, 0);
    assert.equal(plan.exactDupGroups, 0);
    assert.equal(plan.facadeGroups, 0);
    assert.equal(plan.unknown.owned, 0);
    assert.equal(plan.unknown.inventory, 0);
  } finally {
    db.close();
  }

  // verify against prisma
  const rows = await prisma.ownedItem.findMany({ where: { userProfileId: pid } });
  for (const row of rows) assert.equal(row.id, `${pid}:owned:${row.serverId}`);
  // keeper of the bookshelf duplicate survives; the older copy is in inventory
  assert.equal(rows.some((row) => row.globalItemId === 3020097 && row.serverId === 11), true);
  assert.equal(rows.some((row) => row.globalItemId === 3020097 && row.serverId === 10), false);
  // stackable pair preserved
  assert.equal(rows.filter((row) => row.globalItemId === 3020003).length, 2);
  // facade dedup kept the newest door (2010001); 2010012 returned to inventory
  assert.equal(rows.some((row) => row.globalItemId === 2010001), true);
  assert.equal(rows.some((row) => row.globalItemId === 2010012), false);
  // unknown junk gone
  assert.equal(rows.some((row) => row.globalItemId === 9999999), false);
  assert.equal(await prisma.inventoryItem.count({ where: { userProfileId: pid, globalItemId: 0 } }), 0);
  // the returned copies landed in inventory
  const inv = await prisma.inventoryItem.findMany({ where: { userProfileId: pid } });
  assert.equal(inv.find((item) => item.globalItemId === 3020097)?.number, 1);
  assert.equal(inv.find((item) => item.globalItemId === 2010012)?.number, 1);
  // fact delta is seconds now (the second save's derived delta)
  const fact = await prisma.profileSaveFact.findFirstOrThrow({ where: { networkUid: uid, saveVersion: 2 } });
  assert.equal(fact.clientDeltaSeconds, 60);
});
