const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ADR-0038: layouts 1/2/3 must round-trip (activeFloorIndex + per-layout
// floors), and the server must clamp activeFloorIndex to the layouts the
// player's level unlocks (the client stores it as layout*2: 0/2/4).

const testDbName = `.layouts-test-${process.pid}.db`;
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
const { evaluateProfile } = require('../dist/moderation/rules.js');

let seq = 0;
async function seedProfile(name, userLevel = 1) {
  seq += 1;
  const networkUid = String(930000000 + seq);
  const account = { username: name, networkUid, playfishUid: Number(networkUid), sessionId: `session-${seq}` };
  await prisma.userProfile.create({
    data: {
      id: `facebook:${networkUid}`,
      networkUid,
      playfishUid: Number(networkUid),
      firstName: name,
      fullName: `${name} Chef`,
      restaurantName: `${name}'s Restaurant`,
      userLevel,
      demandPoint: 120,
      floors: { create: [0, 1].map((floorIndex) => ({ id: `facebook:${networkUid}:floor:${floorIndex}`, floorIndex, tilesJson: JSON.stringify(Array(800).fill(0)) })) },
    },
  });
  return account;
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

async function savedProfile(account, overrides = {}) {
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
    ...overrides,
  };
}

function floorTilesWith(markerTiles) {
  const tiles = Array(800).fill(0);
  for (const [index, id] of markerTiles) tiles[index] = id;
  return tiles;
}

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('layout 2 (activeFloorIndex 2) round-trips its active index and floor tiles', async () => {
  const account = await seedProfile('layoutroundtrip', 15);
  const tiles = floorTilesWith([[10, 5000008], [11, 5000008], [12, 3020002]]);
  const result = await savePlayerProfile(await savedProfile(account, { activeFloorIndex: 2 }), emptyAudit(1, 100, {
    floorChanges: [{ floorIndex: 2, tiles }],
  }));
  assert.equal(result.status, 'saved');

  const reloaded = await getPlayerProfile(account);
  assert.equal(reloaded.activeFloorIndex, 2);
  const floor2 = reloaded.floors.find((floor) => floor.floorIndex === 2);
  assert.equal(Boolean(floor2), true);
  assert.deepEqual(JSON.parse(floor2.tilesJson), tiles);
  // the starter floors are untouched
  assert.equal(reloaded.floors.some((floor) => floor.floorIndex === 0), true);
});

test('activeFloorIndex is clamped to the layouts the level unlocks', async () => {
  // level 5 -> only layout 0 (max activeFloorIndex 0)
  const low = await seedProfile('layoutlow', 5);
  await savePlayerProfile(await savedProfile(low, { activeFloorIndex: 4 }), emptyAudit(1, 100));
  assert.equal((await getPlayerProfile(low)).activeFloorIndex, 0);

  // level 15 -> layouts 1-2 (max activeFloorIndex 2)
  const mid = await seedProfile('layoutmid', 15);
  await savePlayerProfile(await savedProfile(mid, { activeFloorIndex: 4 }), emptyAudit(1, 100));
  assert.equal((await getPlayerProfile(mid)).activeFloorIndex, 2);

  // level 25 -> all three layouts (max activeFloorIndex 4)
  const high = await seedProfile('layouthigh', 25);
  await savePlayerProfile(await savedProfile(high, { activeFloorIndex: 4 }), emptyAudit(1, 100));
  assert.equal((await getPlayerProfile(high)).activeFloorIndex, 4);
});

test('odd activeFloorIndex values are normalized to the even layout encoding', async () => {
  const account = await seedProfile('layoutodd', 15);
  await savePlayerProfile(await savedProfile(account, { activeFloorIndex: 3 }), emptyAudit(1, 100));
  assert.equal((await getPlayerProfile(account)).activeFloorIndex, 2);
});

test('moderation layout rule accepts a legit layout-1 profile and flags unearned layouts', () => {
  const base = {
    networkUid: 'layout-rule', credits: 0, cashBalance: 250, userLevel: 15, createdAt: new Date(),
    ownedItems: [], inventoryItems: [], ingredients: [], gardenPlots: [], employees: [], cashTransactions: [],
  };
  const activity = { totalActiveSeconds: 3600, loginCount: 1, requestCount: 1, saveCount: 1 };
  // gourmet 150000 -> 15000 tenths -> level 13 -> layouts 2; activeFloorIndex 2 == layout 1: legit.
  const legit = evaluateProfile({ ...base, gourmetPoint: 150000, activeFloorIndex: 2 }, activity, null, new Date());
  assert.equal(legit.some((finding) => finding.ruleId === 'LAYOUT_UNLOCK_EXCEEDED'), false);
  // same level but layout 2 (activeFloorIndex 4): unearned.
  const early = evaluateProfile({ ...base, gourmetPoint: 150000, activeFloorIndex: 4 }, activity, null, new Date());
  assert.equal(early.some((finding) => finding.ruleId === 'LAYOUT_UNLOCK_EXCEEDED'), true);
  // odd (unrenderable) value is flagged.
  const odd = evaluateProfile({ ...base, gourmetPoint: 150000, activeFloorIndex: 3 }, activity, null, new Date());
  assert.equal(odd.some((finding) => finding.ruleId === 'LAYOUT_UNLOCK_EXCEEDED'), true);
});
