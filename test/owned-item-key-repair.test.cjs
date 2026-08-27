const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ADR-0039: legacy OwnedItem rows whose id does not match their serverId
// (e.g. id `…:owned:-8` with serverId 1) collide with fresh client negative
// uids in `ownedItem.upsert()` and crash the save with "Unique constraint
// failed on the fields: (id)". The repair must fix them on save and on
// delivery so those saves succeed.

const testDbName = `.owned-item-key-test-${process.pid}.db`;
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
const { getPlayerProfile, savePlayerProfile } = require('../dist/db/profile-store.js');

let seq = 0;
async function seedProfile(name, ownedRowsFactory) {
  seq += 1;
  const networkUid = String(940000000 + seq);
  const account = { username: name, networkUid, playfishUid: Number(networkUid), sessionId: `session-${seq}` };
  const profileId = `facebook:${networkUid}`;
  await prisma.userProfile.create({
    data: {
      id: profileId,
      networkUid,
      playfishUid: Number(networkUid),
      firstName: name,
      fullName: `${name} Chef`,
      restaurantName: `${name}'s Restaurant`,
      demandPoint: 120,
      ownedItems: { create: ownedRowsFactory(profileId).map((row) => ({ id: row.id, serverId: row.serverId, globalItemId: row.globalItemId, positionX: row.positionX ?? 0, positionY: row.positionY ?? 0, data: 0, roomIndex: 0 })) },
    },
  });
  return { account, profileId };
}

function emptyAudit(saveVersion, timeOnClient, overrides = {}) {
  return {
    saveVersion,
    timeOnClient,
    creditDelta: 0,
    newCredits: null,
    upsertOwnedItems: [],
    removeOwnedItemIds: [],
    inventoryChanges: [],
    bulkInventoryMoves: [],
    ingredientChanges: [],
    lockIngredientChanges: [],
    gardenChanges: [],
    floorChanges: [],
    employeeChanges: [],
    openMailIds: [],
    deleteMailIds: [],
    visitedFriends: [],
    purchases: [],
    ...overrides,
  };
}

async function savedProfile(account) {
  const current = await getPlayerProfile(account);
  return {
    id: { network: 2, networkUid: account.networkUid, playfishUid: account.playfishUid },
    restaurantName: current.restaurantName,
    gourmetPoint: current.gourmetPoint,
    trashPoint: current.trashPoint,
    demandPoint: current.demandPoint,
    musicPlay: current.musicPlay,
    isInStreet: current.isInStreet,
    awards: current.awards ? Buffer.from(current.awards) : null,
    userLevel: current.userLevel,
    activeFloorIndex: current.activeFloorIndex,
  };
}

function ownedItem(serverId, globalItemId, positionX = 3, positionY = 4) {
  return { serverId, globalItemId, positionX, positionY, data: 0, roomIndex: 0, employee: { network: 0, networkUid: '', playfishUid: 0 } };
}

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('a save that reuses a stale negative id no longer crashes the upsert', async () => {
  const { account, profileId } = await seedProfile('keycrash', (pid) => [
    { id: `${pid}:owned:-8`, serverId: 1, globalItemId: 3020017 }, // legacy mismatch
    { id: `${pid}:owned:2`, serverId: 2, globalItemId: 3030010 },
  ]);

  // The client session generates uid -8 again (fresh SWF) and places an item.
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    upsertOwnedItems: [ownedItem(-8, 3020017, 5, 5)],
  }));
  assert.equal(result.status, 'saved');

  const rows = await prisma.ownedItem.findMany({ where: { userProfileId: profileId } });
  // every row's id must match its serverId, and both placements exist
  for (const row of rows) assert.equal(row.id, `${profileId}:owned:${row.serverId}`);
  assert.equal(rows.some((row) => row.serverId === -8 && row.positionX === 5), true);
  assert.equal(rows.some((row) => row.serverId === 1), true);
});

test('delivery repairs id/serverId mismatches and renumbers rows whose correct id is taken', async () => {
  const { account, profileId } = await seedProfile('keycollision', (pid) => [
    { id: `${pid}:owned:7`, serverId: 1, globalItemId: 3020017 }, // wants :owned:1 (taken)
    { id: `${pid}:owned:1`, serverId: 2, globalItemId: 3030010 }, // wants :owned:2 (taken)
    { id: `${pid}:owned:2`, serverId: 3, globalItemId: 3040018 }, // consistent
  ]);

  const delivered = await getPlayerProfile(account);
  const rows = await prisma.ownedItem.findMany({ where: { userProfileId: profileId } });
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.id, `${profileId}:owned:${row.serverId}`);
  // the consistent row kept its identity
  assert.equal(rows.some((row) => row.serverId === 3 && row.globalItemId === 3040018), true);
  assert.equal(new Set(rows.map((row) => row.serverId)).size, rows.length);
  assert.equal(delivered.ownedItems.length, 3);
});

test('a fresh client uid equal to a stale id suffix is granted without collision', async () => {
  const { account, profileId } = await seedProfile('keyfresh', (pid) => [
    { id: `${pid}:owned:-5`, serverId: 1, globalItemId: 3050001 },
  ]);
  // The stale row is delivered first (repair renames it), then a save creates a
  // new placement under uid -5.
  await getPlayerProfile(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    upsertOwnedItems: [ownedItem(-5, 3050001, 9, 9)],
  }));
  assert.equal(result.status, 'saved');
  const rows = await prisma.ownedItem.findMany({ where: { userProfileId: profileId } });
  for (const row of rows) assert.equal(row.id, `${profileId}:owned:${row.serverId}`);
  assert.equal(rows.length, 2);
});
