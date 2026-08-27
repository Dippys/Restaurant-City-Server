const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.persistence-integrity-test-${process.pid}.db`;
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
const { sendMail, swapIngredient } = require('../dist/db/rpc-store.js');
const { grantMailItem } = require('../dist/db/system-mail.js');
const { buildResponse } = require('../dist/rpc/index.js');
const { writeBool, writeNetworkUid, writeString, writeU8, writeVarint } = require('../dist/rpc/codec.js');

let seq = 0;
async function seedProfile(name, ownedItems = []) {
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
      demandPoint: 120,
      inventoryItems: { create: [{ id: `facebook:${networkUid}:inventory:5000008`, globalItemId: 5000008, number: 1, isSelected: true }] },
      floors: { create: [0, 1].map((floorIndex) => ({ id: `facebook:${networkUid}:floor:${floorIndex}`, floorIndex, tilesJson: JSON.stringify(Array(800).fill(0)) })) },
      ownedItems: {
        create: ownedItems.map((item, index) => ({
          id: `facebook:${networkUid}:owned:test:${index}`,
          serverId: item.serverId,
          globalItemId: item.globalItemId,
          positionX: item.positionX ?? 0,
          positionY: item.positionY ?? 0,
          data: 0,
          roomIndex: 0,
          updatedAt: item.updatedAt,
          createdAt: item.updatedAt,
        })),
      },
    },
  });
  return account;
}

async function setIngredient(account, globalItemId, number, isLocked = false) {
  await prisma.ingredientInventory.upsert({
    where: { userProfileId_globalItemId: { userProfileId: `facebook:${account.networkUid}`, globalItemId } },
    update: { number, isLocked },
    create: { id: `facebook:${account.networkUid}:ingredient:${globalItemId}`, userProfileId: `facebook:${account.networkUid}`, globalItemId, number, isLocked },
  });
}

// Direct trades require the target to be on the caller's "Your Street" roster
// (the client only offers the trade button on the Friends street). These helpers
// mirror a real hire: an enabled account + an Employee row on the owner.
async function makeAccountBacked(account) {
  await prisma.account.upsert({
    where: { networkUid: account.networkUid },
    update: {},
    create: {
      id: `account-${account.networkUid}`,
      username: account.username,
      usernameKey: `key-${account.networkUid}`,
      firstName: account.username,
      lastName: 'Chef',
      pinHash: 'test',
      pinSalt: 'test',
      networkUid: account.networkUid,
      playfishUid: account.playfishUid,
    },
  });
}

async function makeFriends(owner, friend) {
  await makeAccountBacked(owner);
  await makeAccountBacked(friend);
  await prisma.employee.upsert({
    where: { userProfileId_networkUid: { userProfileId: `facebook:${owner.networkUid}`, networkUid: friend.networkUid } },
    update: {},
    create: {
      id: `facebook:${owner.networkUid}:employee:${friend.networkUid}`,
      userProfileId: `facebook:${owner.networkUid}`,
      network: 2,
      networkUid: friend.networkUid,
      playfishUid: friend.playfishUid,
      happiness: 0,
      task: 0,
      notify: false,
    },
  });
}

async function ingredientCount(account, globalItemId) {
  return (await prisma.ingredientInventory.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: `facebook:${account.networkUid}`, globalItemId } },
  }))?.number ?? 0;
}

async function ingredientLocked(account, globalItemId) {
  return (await prisma.ingredientInventory.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: `facebook:${account.networkUid}`, globalItemId } },
  }))?.isLocked ?? false;
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
    ...overrides,
  };
}

function savedProfile(account, current, overrides = {}) {
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

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('profile delivery stabilizes restart-local IDs and returns impossible facade duplicates to inventory', async () => {
  const oldDate = new Date('2026-01-01T00:00:00Z');
  const newDate = new Date('2026-02-01T00:00:00Z');
  const account = await seedProfile('layoutrepair', [
    { serverId: -10, globalItemId: 2060000, updatedAt: oldDate },
    { serverId: -11, globalItemId: 2060001, updatedAt: newDate },
    { serverId: -20, globalItemId: 2000014, positionX: 60, updatedAt: oldDate },
    { serverId: -21, globalItemId: 2000014, positionX: -60, updatedAt: oldDate },
    { serverId: -22, globalItemId: 3010000, updatedAt: oldDate },
  ]);

  const delivered = await getPlayerProfile(account);
  assert.equal(delivered.ownedItems.every((item) => item.serverId > 0), true);
  assert.equal(new Set(delivered.ownedItems.map((item) => item.serverId)).size, delivered.ownedItems.length);
  assert.deepEqual(delivered.ownedItems.filter((item) => Math.floor(item.globalItemId / 10000) === 206).map((item) => item.globalItemId), [2060001]);
  assert.equal(delivered.ownedItems.filter((item) => item.globalItemId === 2000014).length, 2);
  assert.equal((await prisma.inventoryItem.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${account.networkUid}`, globalItemId: 2060000 } } })).number, 1);

  const stableIds = delivered.ownedItems.map((item) => item.serverId);
  assert.deepEqual((await getPlayerProfile(account)).ownedItems.map((item) => item.serverId), stableIds);
});

test('avatar tutorial can reuse local id -1 after a normalized profile reload', async () => {
  const account = await seedProfile('avatartutorial', [
    { serverId: -1, globalItemId: 2060000 },
    { serverId: -2, globalItemId: 2020001 },
    { serverId: -3, globalItemId: 2010012 },
  ]);
  const delivered = await getPlayerProfile(account);
  const normalizedRows = await prisma.ownedItem.findMany({ where: { userProfileId: `facebook:${account.networkUid}` } });
  assert.equal(normalizedRows.every((item) => item.serverId > 0), true);
  assert.equal(normalizedRows.every((item) => item.id === `facebook:${account.networkUid}:owned:${item.serverId}`), true);

  await savePlayerProfile({
    id: { network: 2, networkUid: account.networkUid, playfishUid: account.playfishUid },
    restaurantName: delivered.restaurantName,
    gourmetPoint: delivered.gourmetPoint,
    trashPoint: delivered.trashPoint,
    demandPoint: delivered.demandPoint,
    musicPlay: delivered.musicPlay,
    isInStreet: delivered.isInStreet,
    awards: delivered.awards ? Buffer.from(delivered.awards) : null,
    userLevel: delivered.userLevel,
    activeFloorIndex: delivered.activeFloorIndex,
  }, {
    saveVersion: delivered.saveVersion,
    timeOnClient: 0,
    creditDelta: 0,
    newCredits: null,
    upsertOwnedItems: [{
      serverId: -1,
      globalItemId: 1040005,
      positionX: 0,
      positionY: 0,
      data: 0,
      roomIndex: 0,
      employee: { network: 0, networkUid: '', playfishUid: 0 },
    }],
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
  });

  const localAvatar = await prisma.ownedItem.findUnique({
    where: { userProfileId_serverId: { userProfileId: `facebook:${account.networkUid}`, serverId: -1 } },
  });
  assert.equal(localAvatar.globalItemId, 1040005);
  const reloaded = await getPlayerProfile(account);
  assert.equal(reloaded.ownedItems.some((item) => item.globalItemId === 1040005 && item.serverId > 0), true);
  assert.equal((await prisma.ownedItem.findMany({ where: { userProfileId: `facebook:${account.networkUid}` } }))
    .every((item) => item.id === `facebook:${account.networkUid}:owned:${item.serverId}`), true);
});

test('save fencing applies each RPC-session version once and rejects stale restaurant, floor, and garden mutations', async () => {
  const account = await seedProfile('savefence', [
    { serverId: 10, globalItemId: 3010000 },
  ]);
  const accountId = `account-${account.networkUid}`;
  const authSessionId = `auth-${account.networkUid}`;
  const rpcSessionToken = `rpc-${account.networkUid}`;
  await prisma.account.create({ data: {
    id: accountId,
    username: account.username,
    usernameKey: account.username,
    firstName: account.username,
    lastName: 'Chef',
    pinHash: 'test',
    pinSalt: 'test',
    networkUid: account.networkUid,
    playfishUid: account.playfishUid,
  } });
  await prisma.session.create({ data: {
    id: authSessionId,
    tokenHash: `token-${account.networkUid}`,
    csrfToken: 'csrf',
    accountId,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    rpcSessionToken,
  } });

  const before = await getPlayerProfile(account);
  const profile = savedProfile(account, before, { restaurantName: 'Durable Restaurant' });
  const durableFloor = Array(800).fill(0);
  durableFloor[0] = 5000008;
  durableFloor[1] = 5000008;
  const firstAudit = emptyAudit(1, 1000, {
    creditDelta: 500,
    upsertOwnedItems: [{
      serverId: 11,
      globalItemId: 3020000,
      positionX: 4,
      positionY: 5,
      data: 0,
      roomIndex: 0,
      employee: { network: 0, networkUid: '', playfishUid: 0 },
    }],
    floorChanges: [{ floorIndex: 1, tiles: durableFloor }],
    gardenChanges: [{ plotId: 0, action: 'seed' }],
  });
  const fence = { authSessionId, rpcSessionToken, payloadDigest: 'digest-v1' };

  assert.deepEqual(await savePlayerProfile(profile, firstAudit, fence), { status: 'saved', savedVersion: 1 });
  assert.deepEqual(await savePlayerProfile(profile, firstAudit, fence), { status: 'duplicate', savedVersion: 1 });

  const staleAudit = emptyAudit(1, 2000, {
    newCredits: 1,
    removeOwnedItemIds: [11],
    floorChanges: [{ floorIndex: 1, tiles: [] }],
    gardenChanges: [{ plotId: 0, action: 'harvest' }],
  });
  assert.deepEqual(
    await savePlayerProfile(savedProfile(account, before, { restaurantName: 'Stale Restaurant' }), staleAudit, {
      authSessionId,
      rpcSessionToken,
      payloadDigest: 'different-v1',
    }),
    { status: 'stale', savedVersion: 1 },
  );

  const stored = await getPlayerProfile(account);
  assert.equal(stored.restaurantName, 'Durable Restaurant');
  assert.equal(stored.credits, before.credits + 500);
  assert.equal(stored.ownedItems.some((item) => item.serverId === 11 && item.globalItemId === 3020000), true);
  assert.deepEqual(JSON.parse(stored.floors.find((floor) => floor.floorIndex === 1).tilesJson), durableFloor);
  assert.equal(stored.gardenPlots.some((plot) => plot.plotId === 0), true);

  assert.deepEqual(
    await savePlayerProfile(savedProfile(account, stored), emptyAudit(2, 3000), {
      authSessionId,
      rpcSessionToken,
      payloadDigest: 'digest-v2',
    }),
    { status: 'saved', savedVersion: 2 },
  );
});

test('profile delivery restores only facade and restaurant-door defaults with exact legacy-slot collision evidence', async () => {
  const account = await seedProfile('facadecollision', [
    { serverId: -1, globalItemId: 2060000 },
    { serverId: -2, globalItemId: 2020001 },
    { serverId: -3, globalItemId: 2010012 },
    { serverId: -4, globalItemId: 3030010 }, // starter Banner slot was overwritten
    { serverId: -7, globalItemId: 3040001 }, // starter Wall Tile slot was overwritten
    { serverId: -13, globalItemId: 1200008 }, // starter restaurant Door slot was overwritten
  ]);

  const delivered = await getPlayerProfile(account);
  assert.equal(delivered.ownedItems.some((item) => item.globalItemId === 2070000), true);
  assert.equal(delivered.ownedItems.some((item) => item.globalItemId === 2050008), true);
  assert.equal(delivered.ownedItems.some((item) => item.globalItemId === 3010000), true);
  assert.equal(delivered.ownedItems.some((item) => item.globalItemId === 3030010), true);
  assert.equal(delivered.ownedItems.some((item) => item.globalItemId === 3040001), true);
  assert.equal(delivered.ownedItems.some((item) => item.globalItemId === 1200008), true);
  assert.equal(delivered.ownedItems.every((item) => item.serverId > 0), true);

  const stableIds = delivered.ownedItems.map((item) => item.serverId);
  assert.deepEqual((await getPlayerProfile(account)).ownedItems.map((item) => item.serverId), stableIds);

  const intentional = await seedProfile('facadeinventory', [
    { serverId: -1, globalItemId: 2060000 },
    { serverId: -2, globalItemId: 2020001 },
    { serverId: -3, globalItemId: 2010012 },
    { serverId: -4, globalItemId: 3030010 },
    { serverId: -13, globalItemId: 1200008 },
  ]);
  await prisma.inventoryItem.create({
    data: {
      id: `facebook:${intentional.networkUid}:inventory:2070001`,
      userProfileId: `facebook:${intentional.networkUid}`,
      globalItemId: 2070001,
      number: 1,
      isSelected: false,
    },
  });
  await prisma.inventoryItem.create({
    data: {
      id: `facebook:${intentional.networkUid}:inventory:3010000`,
      userProfileId: `facebook:${intentional.networkUid}`,
      globalItemId: 3010000,
      number: 1,
      isSelected: false,
    },
  });
  const intentionallyInventoried = await getPlayerProfile(intentional);
  assert.equal(intentionallyInventoried.ownedItems.some((item) => Math.floor(item.globalItemId / 10000) === 207), false);
  assert.equal(intentionallyInventoried.ownedItems.some((item) => Math.floor(item.globalItemId / 10000) === 301), false);
});

test('direct trades persist both players atomically and reject invalid hashes, locks, and missing stock', async () => {
  const player = await seedProfile('directplayer');
  const target = await seedProfile('directtarget');
  await makeFriends(player, target);
  await setIngredient(player, 4000002, 1); // rarity 3
  await setIngredient(target, 4000004, 1); // rarity 1, unlocked

  assert.equal(await swapIngredient(player, { network: 2, networkUid: target.networkUid, playfishUid: target.playfishUid }, 'DiaUr54yPWANy48rDe5jwa', 'jn7oj0vkTbuJkKA5QjzGda', false, 0), 0);
  assert.equal(await ingredientCount(player, 4000002), 0);
  assert.equal(await ingredientCount(player, 4000004), 1);
  assert.equal(await ingredientLocked(player, 4000004), true);
  assert.equal(await ingredientCount(target, 4000004), 0);
  assert.equal(await ingredientCount(target, 4000002), 1);
  assert.equal(await ingredientLocked(target, 4000002), true);
  assert.equal(await swapIngredient(player, { network: 2, networkUid: target.networkUid, playfishUid: target.playfishUid }, 'not-a-hash', 'jn7oj0vkTbuJkKA5QjzGda', false, 0), 4);
  await setIngredient(player, 4000002, 1);
  await setIngredient(target, 4000004, 1, true);
  assert.equal(await swapIngredient(player, { network: 2, networkUid: target.networkUid, playfishUid: target.playfishUid }, 'DiaUr54yPWANy48rDe5jwa', 'jn7oj0vkTbuJkKA5QjzGda', false, 0), 4);
  await setIngredient(target, 4000004, 1, false);
  await setIngredient(player, 4000002, 0);
  assert.equal(await swapIngredient(player, { network: 2, networkUid: target.networkUid, playfishUid: target.playfishUid }, 'DiaUr54yPWANy48rDe5jwa', 'jn7oj0vkTbuJkKA5QjzGda', false, 0), 4);
});

test('secure trade acceptance requires a matching live mail and cannot be replayed', async () => {
  const accepter = await seedProfile('secureaccepter');
  const offerer = await seedProfile('secureofferer');
  await setIngredient(accepter, 4000004, 1); // accepter gives rarity 1
  await setIngredient(offerer, 4000002, 1, true); // offerer gives rarity 3 through secure mail
  const mail = await prisma.mail.create({
    data: {
      senderProfileId: `facebook:${offerer.networkUid}`,
      recipientProfileId: `facebook:${accepter.networkUid}`,
      senderNetwork: 2,
      senderNetworkUid: offerer.networkUid,
      senderPlayfishUid: offerer.playfishUid,
      recipientNetwork: 2,
      recipientNetworkUid: accepter.networkUid,
      recipientPlayfishUid: accepter.playfishUid,
      globalItemIdsJson: JSON.stringify([4000002, 4000004]),
      sendDate: 1,
      type: 6,
    },
  });

  const target = { network: 2, networkUid: offerer.networkUid, playfishUid: offerer.playfishUid };
  assert.equal(await swapIngredient(accepter, target, 'jn7oj0vkTbuJkKA5QjzGda', 'DiaUr54yPWANy48rDe5jwa', true, mail.id), 0);
  assert.equal(await ingredientCount(accepter, 4000004), 0);
  assert.equal(await ingredientCount(accepter, 4000002), 1);
  assert.equal(await ingredientCount(offerer, 4000002), 0);
  assert.equal(await ingredientCount(offerer, 4000004), 1);
  assert.equal((await prisma.mail.findUnique({ where: { id: mail.id } })).deleted, true);
  assert.equal(await swapIngredient(accepter, target, 'jn7oj0vkTbuJkKA5QjzGda', 'DiaUr54yPWANy48rDe5jwa', true, mail.id), 4);

  assert.equal(await sendMail(accepter, { recipient: target, globalItemIds: [123, 4000002], itemId: 0, message: '', type: 6 }), 4);
});

test('RPC 17 keeps the shipped request and one-byte status response layout', async () => {
  const player = await seedProfile('wireplayer');
  const target = await seedProfile('wiretarget');
  await makeFriends(player, target);
  await setIngredient(player, 4000002, 1);
  await setIngredient(target, 4000004, 1);
  const request = Buffer.concat([
    writeU8(0),
    writeU8(17),
    writeString('flash-session'),
    writeNetworkUid(2, target.networkUid, target.playfishUid),
    writeString('DiaUr54yPWANy48rDe5jwa'),
    writeString('jn7oj0vkTbuJkKA5QjzGda'),
    writeBool(false),
    writeVarint(0),
    writeBool(true),
  ]);
  const result = await buildResponse(request, player);
  assert.equal(result.response.toString('hex'), '001100');
  assert.equal(result.summary.call, 'swapIngredient');
});

test('direct trades are rejected when the target is not on the caller\'s Friends street', async () => {
  const player = await seedProfile('nofriendplayer');
  const target = await seedProfile('nofriendtarget');
  await setIngredient(player, 4000002, 1); // rarity 3
  await setIngredient(target, 4000004, 1); // rarity 1, unlocked
  const targetRef = { network: 2, networkUid: target.networkUid, playfishUid: target.playfishUid };

  assert.equal(await swapIngredient(player, targetRef, 'DiaUr54yPWANy48rDe5jwa', 'jn7oj0vkTbuJkKA5QjzGda', false, 0), 4);
  // Nothing moved.
  assert.equal(await ingredientCount(player, 4000002), 1);
  assert.equal(await ingredientCount(target, 4000004), 1);
  assert.equal(await ingredientCount(target, 4000002), 0);

  // A secure trade mail to a non-friend is rejected the same way.
  assert.equal(await sendMail(player, { recipient: targetRef, globalItemIds: [4000002, 4000004], itemId: 0, message: '', type: 6 }), 4);
});

test('NPC trades cannot mint ingredients the NPC does not hold', async () => {
  const player = await seedProfile('npctrader');
  const npcTarget = { network: 2, networkUid: '1001', playfishUid: 1001 };
  await setIngredient(player, 4000002, 1); // rarity 3

  // Direct swap requesting an ingredient the NPC does not hold is rejected,
  // even when the offered rarity is higher.
  assert.equal(await swapIngredient(player, npcTarget, 'DiaUr54yPWANy48rDe5jwa', '81wnx7e8HLTCwfpyXSucoq', false, 0), 4);
  assert.equal(await ingredientCount(player, 4000022), 0);

  // The mail path (auto-accept) is gated the same way.
  assert.equal(await sendMail(player, { recipient: npcTarget, globalItemIds: [4000002, 4000022], itemId: 0, message: '', type: 6 }), 4);

  // A held, unlocked starter with equal-or-higher offered rarity still works.
  assert.equal(await swapIngredient(player, npcTarget, 'DiaUr54yPWANy48rDe5jwa', '5citJlTD__mpVTc2nE05UG', false, 0), 0);
  assert.equal(await ingredientCount(player, 4000013), 1);
  assert.equal(await ingredientLocked(player, 4000013), true);

  // And through the mail path.
  await setIngredient(player, 4000002, 1);
  assert.equal(await sendMail(player, { recipient: npcTarget, globalItemIds: [4000002, 4000013], itemId: 0, message: '', type: 6 }), 0);
  assert.equal(await ingredientCount(player, 4000013), 2);
});

test('ingredients received through grants and profile deltas start locked', async () => {
  const player = await seedProfile('autolockplayer');

  // Mail grants (gift / daily bonus) land locked, including on a stack that
  // already exists.
  await grantMailItem(player.networkUid, 4000001);
  assert.equal(await ingredientLocked(player, 4000001), true);
  assert.equal(await ingredientCount(player, 4000001), 1);
  await grantMailItem(player.networkUid, 4000001);
  assert.equal(await ingredientLocked(player, 4000001), true);
  assert.equal(await ingredientCount(player, 4000001), 2);

  // Client-reported receives (harvest, quiz, market purchase, first-visit gift)
  // land locked too, while consuming leaves the lock alone.
  const profile = await getPlayerProfile(player);
  await savePlayerProfile(savedProfile(player, profile, { userLevel: 5, gourmetPoint: 1000 }), emptyAudit(1, 60, {
    ingredientChanges: [{ globalItemId: 4000003, delta: 1 }, { globalItemId: 4000001, delta: -1 }],
  }));
  assert.equal(await ingredientLocked(player, 4000003), true);
  assert.equal(await ingredientCount(player, 4000003), 1);
  assert.equal(await ingredientLocked(player, 4000001), true);
  assert.equal(await ingredientCount(player, 4000001), 1);

  // The owner can still unlock explicitly (saveProfile action 9).
  await savePlayerProfile(savedProfile(player, profile, { userLevel: 5, gourmetPoint: 1000 }), emptyAudit(2, 120, {
    lockIngredientChanges: [{ globalItemId: 4000003, isLocked: false }],
  }));
  assert.equal(await ingredientLocked(player, 4000003), false);
});
