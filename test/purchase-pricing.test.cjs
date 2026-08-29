const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ADR-0035: coin purchases are priced server-side at save-apply time. The
// shipped client deducts the price only from its local balance and sends no
// credit delta, so the server must charge the authoritative price and reject
// unaffordable or invalid purchase batches.

const testDbName = `.purchase-pricing-test-${process.pid}.db`;
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
const { parseSaveProfile } = require('../dist/rpc/save-profile-parser.js');
const { writeBool, writeIntvar32, writeNetworkUid, writeString, writeU8, writeVarint } = require('../dist/rpc/codec.js');

// Shipped prices from server/public/data (restaurant.xml / perk.xml).
const WHITE_ROOM_DIVIDER = 3020017; // cost 200, hash voNvhmQe5ogIYR21dTGXJa
const RED_BRICK_PILLAR = 3020030; // cost 1100, hash 3Sa4YP7xjnf.CerAt_gFna
const KOI_POND = 3020123; // cash 15, no coin cost (PF-cash only)
const SKILL_BOOK_PERK = 6000005; // perk.xml cost 100
const CLASSIC_HAIR = 1040005; // avatar.xml cost 0 (starter outfit)
const SEED_COST = 2000; // GardenPlot.as:15
const OUTSIDE_AREA_7X6 = 3900000; // restaurant.xml cost 2500, level 10 garden expansion

let seq = 0;
async function seedProfile(name, credits = 50000) {
  seq += 1;
  const networkUid = String(920000000 + seq);
  const account = { username: name, networkUid, playfishUid: Number(networkUid), sessionId: `session-${seq}` };
  await prisma.userProfile.create({
    data: {
      id: `facebook:${networkUid}`,
      networkUid,
      playfishUid: Number(networkUid),
      firstName: name,
      fullName: `${name} Chef`,
      restaurantName: `${name}'s Restaurant`,
      credits,
      demandPoint: 120,
      floors: { create: [0, 1].map((floorIndex) => ({ id: `facebook:${networkUid}:floor:${floorIndex}`, floorIndex, tilesJson: JSON.stringify(Array(800).fill(0)) })) },
    },
  });
  return account;
}

async function setupFence(account) {
  const accountId = `account-${account.networkUid}`;
  const authSessionId = `auth-${account.networkUid}`;
  const rpcSessionToken = `rpc-${account.networkUid}`;
  await prisma.account.create({ data: {
    id: accountId, username: account.username, usernameKey: account.username,
    firstName: account.username, lastName: 'Chef', pinHash: 'test', pinSalt: 'test',
    networkUid: account.networkUid, playfishUid: account.playfishUid,
  } });
  await prisma.session.create({ data: {
    id: authSessionId, tokenHash: `token-${account.networkUid}`, csrfToken: 'csrf', accountId,
    expiresAt: new Date('2030-01-01T00:00:00Z'), rpcSessionToken,
  } });
  return { authSessionId, rpcSessionToken };
}

function ownedItem(serverId, globalItemId, positionX = 3, positionY = 4) {
  return { serverId, globalItemId, positionX, positionY, data: 0, roomIndex: 0, employee: { network: 0, networkUid: '', playfishUid: 0 } };
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

async function credits(account) {
  return (await getPlayerProfile(account)).credits;
}

async function ownedCount(account, globalItemId) {
  return (await prisma.ownedItem.findMany({ where: { userProfileId: `facebook:${account.networkUid}`, globalItemId } })).length;
}

async function inventoryNumber(account, globalItemId) {
  return (await prisma.inventoryItem.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: `facebook:${account.networkUid}`, globalItemId } },
  }))?.number ?? 0;
}

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('placing a bought item deducts its shipped coin cost', async () => {
  const account = await seedProfile('placedbuy');
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    upsertOwnedItems: [ownedItem(-1, WHITE_ROOM_DIVIDER)],
    purchases: [{ kind: 'owned', itemId: WHITE_ROOM_DIVIDER, qty: 1 }],
  }), { ...fence, payloadDigest: 'placed-v1' });
  assert.equal(result.status, 'saved');
  assert.equal(await credits(account), 50000 - 200);
  assert.equal(await ownedCount(account, WHITE_ROOM_DIVIDER), 1);
});

test('outdoor and facade decoration purchases are priced like any other item', async () => {
  const account = await seedProfile('outdoordecor');
  const fence = await setupFence(account);
  const GREEN_BUSH = 3120000; // restaurant.xml cost 500 (outside-area patio item)
  const BASIC_WINDOW = 2000014; // front.xml cost 200 (building facade item)
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    upsertOwnedItems: [
      { ...ownedItem(-1, GREEN_BUSH), roomIndex: 1 }, // ROOM_INDEX_OUTSIDE_AREA
      ownedItem(-2, BASIC_WINDOW),
    ],
    purchases: [
      { kind: 'owned', itemId: GREEN_BUSH, qty: 1 },
      { kind: 'owned', itemId: BASIC_WINDOW, qty: 1 },
    ],
  }), { ...fence, payloadDigest: 'outdoor-v1' });
  assert.equal(result.status, 'saved');
  assert.equal(await credits(account), 50000 - 500 - 200);
  const placed = await prisma.ownedItem.findMany({ where: { userProfileId: `facebook:${account.networkUid}` } });
  assert.equal(placed.some((item) => item.globalItemId === GREEN_BUSH && item.roomIndex === 1), true);
  assert.equal(placed.some((item) => item.globalItemId === BASIC_WINDOW), true);
});

test('the level-10 garden expansion persists and charges its XML price', async () => {
  const account = await seedProfile('gardenexpansion');
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    upsertOwnedItems: [{ ...ownedItem(-1, OUTSIDE_AREA_7X6), roomIndex: 1 }],
    purchases: [{ kind: 'owned', itemId: OUTSIDE_AREA_7X6, qty: 1 }],
  }), { ...fence, payloadDigest: 'garden-expansion-v1' });
  assert.equal(result.status, 'saved');
  assert.equal(await credits(account), 50000 - 2500);
  assert.equal(await ownedCount(account, OUTSIDE_AREA_7X6), 1);
});

test('selling an owned item removes it and applies the client sale credit', async () => {
  const account = await seedProfile('itemsale');
  const profileId = `facebook:${account.networkUid}`;
  await prisma.ownedItem.create({ data: {
    id: `${profileId}:owned:7`, userProfileId: profileId, serverId: 7,
    globalItemId: WHITE_ROOM_DIVIDER, positionX: 3, positionY: 4, data: 0,
    roomIndex: 0, employeeNetwork: 0, employeeNetworkUid: '', employeePlayfishUid: 0,
  } });
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    creditDelta: 100,
    removeOwnedItemIds: [7],
  }), { ...fence, payloadDigest: 'sale-v1' });
  assert.equal(result.status, 'saved');
  assert.equal(await credits(account), 50100);
  assert.equal(await ownedCount(account, WHITE_ROOM_DIVIDER), 0);
});

test('inventory purchase resolves the hash token and charges cost × qty', async () => {
  const account = await seedProfile('inventorybuy');
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    inventoryChanges: [{ globalItemId: RED_BRICK_PILLAR, delta: 2 }],
    purchases: [{ kind: 'inventory', itemId: RED_BRICK_PILLAR, qty: 2, token: '3Sa4YP7xjnf.CerAt_gFna' }],
  }), { ...fence, payloadDigest: 'inventory-v1' });
  assert.equal(result.status, 'saved');
  assert.equal(await credits(account), 50000 - 2 * 1100);
  assert.equal(await inventoryNumber(account, RED_BRICK_PILLAR), 2);
});

test('perk purchase charges the perk cost', async () => {
  const account = await seedProfile('perkbuy');
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    inventoryChanges: [{ globalItemId: SKILL_BOOK_PERK, delta: 1 }],
    purchases: [{ kind: 'perk', itemId: SKILL_BOOK_PERK, qty: 1 }],
  }), { ...fence, payloadDigest: 'perk-v1' });
  assert.equal(result.status, 'saved');
  assert.equal(await credits(account), 50000 - 100);
});

test('seed planting charges GardenPlot.SEED_COST per seed', async () => {
  const account = await seedProfile('seedbuy');
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    gardenChanges: [{ plotId: 0, action: 'seed' }],
    purchases: [{ kind: 'seed', qty: 1 }],
  }), { ...fence, payloadDigest: 'seed-v1' });
  assert.equal(result.status, 'saved');
  assert.equal(await credits(account), 50000 - SEED_COST);
});

test('ingredient purchase charges the enabled market price and rejects disabled markets', async () => {
  const account = await seedProfile('ingredientbuy');
  const fence = await setupFence(account);
  const profileId = `facebook:${account.networkUid}`;
  await prisma.ingredientMarketItem.upsert({
    where: { ingredientId: 4000000 },
    update: { price: 1000, enabled: true },
    create: { ingredientId: 4000000, price: 1000, enabled: true },
  });

  const ok = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    ingredientChanges: [{ globalItemId: 4000000, delta: 1 }],
    purchases: [{ kind: 'ingredient', itemId: 4000000, qty: 1 }],
  }), { ...fence, payloadDigest: 'ingredient-v1' });
  assert.equal(ok.status, 'saved');
  assert.equal(await credits(account), 50000 - 1000);
  assert.equal((await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: 4000000 } } }))?.number, 1);

  await prisma.ingredientMarketItem.update({ where: { ingredientId: 4000000 }, data: { enabled: false } });
  const rejected = await savePlayerProfile(await savedProfile(account), emptyAudit(2, 200, {
    ingredientChanges: [{ globalItemId: 4000000, delta: 1 }],
    purchases: [{ kind: 'ingredient', itemId: 4000000, qty: 1 }],
  }), { ...fence, payloadDigest: 'ingredient-v2' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(await credits(account), 50000 - 1000);
});

test('cost-0 starter avatar items are granted for free', async () => {
  const account = await seedProfile('freeavatar');
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    upsertOwnedItems: [ownedItem(-1, CLASSIC_HAIR)],
    purchases: [{ kind: 'owned', itemId: CLASSIC_HAIR, qty: 1 }],
  }), { ...fence, payloadDigest: 'avatar-v1' });
  assert.equal(result.status, 'saved');
  assert.equal(await credits(account), 50000);
  assert.equal(await ownedCount(account, CLASSIC_HAIR), 1);
});

test('insufficient funds rejects the save atomically and does not wedge the save fence', async () => {
  const account = await seedProfile('poor', 100);
  const fence = await setupFence(account);

  const rejected = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    upsertOwnedItems: [ownedItem(-1, RED_BRICK_PILLAR)],
    purchases: [{ kind: 'owned', itemId: RED_BRICK_PILLAR, qty: 1 }],
  }), { ...fence, payloadDigest: 'poor-v1' });
  assert.deepEqual(rejected, { status: 'rejected', savedVersion: 1 });
  assert.equal(await credits(account), 100);
  assert.equal(await ownedCount(account, RED_BRICK_PILLAR), 0);

  // The fence version was consumed, so the next (solvent) save still lands.
  const next = await savePlayerProfile(await savedProfile(account), emptyAudit(2, 200), { ...fence, payloadDigest: 'poor-v2' });
  assert.deepEqual(next, { status: 'saved', savedVersion: 2 });
  assert.equal(await credits(account), 100);
});

test('cash-only items cannot be bought through the save audit', async () => {
  const account = await seedProfile('cashonly');
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    upsertOwnedItems: [ownedItem(-1, KOI_POND)],
    purchases: [{ kind: 'owned', itemId: KOI_POND, qty: 1 }],
  }), { ...fence, payloadDigest: 'cashonly-v1' });
  assert.equal(result.status, 'rejected');
  assert.equal(await credits(account), 50000);
  assert.equal(await ownedCount(account, KOI_POND), 0);
});

test('an unresolvable purchase token rejects the save', async () => {
  const account = await seedProfile('unknowntoken');
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    purchases: [{ kind: 'inventory', qty: 1, token: 'no-such-hash', unresolved: true }],
  }), { ...fence, payloadDigest: 'unknown-v1' });
  assert.equal(result.status, 'rejected');
  assert.equal(await credits(account), 50000);
});

test('newCredits cannot bypass purchase pricing', async () => {
  const account = await seedProfile('bypass');
  const fence = await setupFence(account);
  const result = await savePlayerProfile(await savedProfile(account), emptyAudit(1, 100, {
    newCredits: 999999,
    upsertOwnedItems: [ownedItem(-1, WHITE_ROOM_DIVIDER)],
    purchases: [{ kind: 'owned', itemId: WHITE_ROOM_DIVIDER, qty: 1 }],
  }), { ...fence, payloadDigest: 'bypass-v1' });
  assert.equal(result.status, 'saved');
  assert.equal(await credits(account), 50000 - 200);
});

test('the save parser records purchase actions and resolves inventory tokens by hash', () => {
  const uid = '1130571586';
  const body = Buffer.concat([
    writeNetworkUid(2, uid, Number(uid)),
    writeString('Parser Test'),
    writeVarint(0), // gourmetPoint
    writeVarint(0), // trashPoint
    writeVarint(120), // demandPoint
    writeVarint(0), // musicPlay
    writeBool(false), // isInStreet
    writeBool(false), // hasAwards
    writeU8(1), // userLevel
    writeU8(0), // activeFloorIndex
    writeVarint(1), // saveVersion
    writeVarint(500), // timeOnClient
    writeVarint(5), // 5 audit changes
    // 22 purchaseOwnedItem: token + OwnedItem
    writeU8(22), writeVarint(0), writeIntvar32(0),
    writeString('voNvhmQe5ogIYR21dTGXJa'),
    writeIntvar32(-1), writeVarint(WHITE_ROOM_DIVIDER), writeIntvar32(3), writeIntvar32(4), writeU8(0),
    writeNetworkUid(0, '', 0), writeU8(0),
    // 3 purchaseInventoryItem: token + qty
    writeU8(3), writeVarint(0), writeIntvar32(0),
    writeString('3Sa4YP7xjnf.CerAt_gFna'), writeVarint(2),
    // 34 purchaseIngredient: itemId + qty
    writeU8(34), writeVarint(0), writeIntvar32(0),
    writeVarint(4000000), writeVarint(1),
    // 38 seedPlant: plotId
    writeU8(38), writeVarint(0), writeIntvar32(0),
    writeVarint(2),
    // 33 addRecipe: learning/leveling does not select the dish
    writeU8(33), writeVarint(0), writeIntvar32(0),
    writeString('jvHIr9RwSDIty3w4pyEJKvCi9R_hAp3Sv2gG3.T4AtJLJ0tugzlJKaZFQ0U1Umro'),
  ]);

  const parsed = parseSaveProfile(body);
  assert.deepEqual(parsed.audit.purchases, [
    { kind: 'owned', itemId: WHITE_ROOM_DIVIDER, qty: 1, token: 'voNvhmQe5ogIYR21dTGXJa' },
    { kind: 'inventory', itemId: RED_BRICK_PILLAR, qty: 2, token: '3Sa4YP7xjnf.CerAt_gFna', unresolved: false },
    { kind: 'ingredient', itemId: 4000000, qty: 1 },
    { kind: 'seed', qty: 1 },
  ]);
  assert.deepEqual(parsed.audit.inventoryChanges, [
    { globalItemId: RED_BRICK_PILLAR, delta: 2 },
    { globalItemId: 5000008, delta: 1 },
  ]);
  assert.deepEqual(parsed.audit.gardenChanges, [{ plotId: 2, action: 'seed' }]);
});
