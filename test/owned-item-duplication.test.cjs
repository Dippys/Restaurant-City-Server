const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ADR-0042: the renumber-on-internal-read loop duplicated owned items. These
// tests pin the fix: renumbering happens only on client-visible delivery, a
// save reusing a stale negative uid merges into its renumbered twin instead of
// creating a row, stackable/wall items are exempt, delivery deletes same-
// position phantoms (keeping the newest), and the moderation clock rules
// compare only within one fence token.

const testDbName = `.owned-item-duplication-test-${process.pid}.db`;
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
const { getPlayerProfile, readOwnerProfile, savePlayerProfile } = require('../dist/db/profile-store.js');
const { recordAcceptedSaveTx, repairFallbackPlayer } = require('../dist/moderation/service.js');
const { captureProfileSnapshot } = require('../dist/moderation/snapshots.js');
const { evaluateProfile } = require('../dist/moderation/rules.js');

let seq = 0;
async function seedProfile(name, ownedItems = []) {
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
      demandPoint: 120,
      floors: { create: [0, 1].map((floorIndex) => ({ id: `facebook:${networkUid}:floor:${floorIndex}`, floorIndex, tilesJson: JSON.stringify(Array(800).fill(0)) })) },
      ownedItems: {
        create: ownedItems.map((item) => ({
          id: `facebook:${networkUid}:owned:${item.serverId}`,
          serverId: item.serverId,
          globalItemId: item.globalItemId,
          positionX: item.positionX ?? 0,
          positionY: item.positionY ?? 0,
          data: item.data ?? 0,
          roomIndex: item.roomIndex ?? 0,
          employeeNetwork: 0,
          employeeNetworkUid: '',
          employeePlayfishUid: 0,
          updatedAt: item.updatedAt,
          createdAt: item.updatedAt,
        })),
      },
    },
  });
  return account;
}

function ownedRows(networkUid) {
  return prisma.ownedItem.findMany({
    where: { userProfileId: `facebook:${networkUid}` },
    orderBy: { serverId: 'asc' },
  });
}

function savedProfile(current, account, overrides = {}) {
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

function emptyAudit(overrides = {}) {
  return {
    saveVersion: 1,
    timeOnClient: 0,
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

function item(serverId, globalItemId, positionX, positionY, data = 0, employee = { network: 0, networkUid: '', playfishUid: 0 }) {
  return { serverId, globalItemId, positionX, positionY, data, roomIndex: 0, employee };
}

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('internal owner reads never renumber; client-visible delivery does', async () => {
  const account = await seedProfile('readonlyowner', [
    { serverId: -5, globalItemId: 3040001, positionX: 2, positionY: 3, updatedAt: new Date('2026-08-01T00:00:00Z') },
  ]);

  // Internal read: the negative row survives untouched (the client still holds it).
  const internal = await readOwnerProfile(account);
  assert.equal(internal.ownedItems.some((row) => row.globalItemId === 3040001 && row.serverId === -5), true);
  assert.equal((await ownedRows(account.networkUid)).some((row) => row.globalItemId === 3040001 && row.serverId === -5), true);

  // Delivery read: renumbered positive, because the response reaches the client.
  const delivered = await getPlayerProfile(account);
  const chairs = delivered.ownedItems.filter((row) => row.globalItemId === 3040001);
  assert.equal(chairs.length, 1, 'exactly one chair row');
  assert.equal(chairs[0].serverId > 0, true);
  const rows = await ownedRows(account.networkUid);
  assert.equal(rows.filter((row) => row.globalItemId === 3040001).length, 1);
  assert.equal(rows.filter((row) => row.globalItemId === 3040001)[0].serverId > 0, true);
});

test('a save reusing a stale negative uid updates the renumbered twin instead of creating a row', async () => {
  const account = await seedProfile('stalereuse', [
    { serverId: -5, globalItemId: 3040001, positionX: 2, positionY: 3, data: 0, updatedAt: new Date('2026-08-01T00:00:00Z') },
  ]);
  // Delivery renumbers -5 -> positive (the client would receive this at load).
  await getPlayerProfile(account);
  const chairs = (await ownedRows(account.networkUid)).filter((row) => row.globalItemId === 3040001);
  assert.equal(chairs.length, 1);
  const twin = chairs[0];
  assert.equal(twin.serverId > 0, true);

  // The live client still holds the item under -5 and saves a rotation change.
  const current = await readOwnerProfile(account);
  const result = await savePlayerProfile(
    savedProfile(current, account),
    emptyAudit({ saveVersion: current.saveVersion, timeOnClient: 10_000, upsertOwnedItems: [item(-5, 3040001, 2, 3, 2)] }),
  );
  assert.equal(result.status, 'saved');

  const after = (await ownedRows(account.networkUid)).filter((row) => row.globalItemId === 3040001);
  assert.equal(after.length, 1, 'no duplicate row was created');
  assert.equal(after[0].id, twin.id, 'the twin row was updated in place');
  assert.equal(after[0].data, 2, 'the audit rotation landed on the twin');
});

test('a fresh negative uid with no twin still creates normally', async () => {
  const account = await seedProfile('freshnegative', []);
  const current = await readOwnerProfile(account);
  await savePlayerProfile(
    savedProfile(current, account),
    emptyAudit({ saveVersion: current.saveVersion, timeOnClient: 5_000, upsertOwnedItems: [item(-1, 3040001, 4, 4, 0)] }),
  );
  const rows = await ownedRows(account.networkUid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].serverId, -1);
  assert.equal(rows[0].globalItemId, 3040001);
});

test('stackable items are exempt from reconciliation and phantom cleanup', async () => {
  const account = await seedProfile('stackedcrates', [
    { serverId: 11, globalItemId: 3020176, positionX: 1, positionY: 1, updatedAt: new Date('2026-08-01T00:00:00Z') },
    { serverId: 12, globalItemId: 3020176, positionX: 1, positionY: 1, updatedAt: new Date('2026-08-02T00:00:00Z') },
  ]);
  // Delivery must keep both stacked Crates (3020176 is type="surface,stackable").
  const delivered = await getPlayerProfile(account);
  assert.equal(delivered.ownedItems.filter((row) => row.globalItemId === 3020176).length, 2);

  // A stale negative save for a third stacked Crate creates a row (legit stack).
  const current = await readOwnerProfile(account);
  await savePlayerProfile(
    savedProfile(current, account),
    emptyAudit({ saveVersion: current.saveVersion, timeOnClient: 15_000, upsertOwnedItems: [item(-1, 3020176, 1, 1, 0)] }),
  );
  const rows = await ownedRows(account.networkUid);
  assert.equal(rows.filter((row) => row.globalItemId === 3020176).length, 3);
});

test('wall decorations are exempt from phantom cleanup', async () => {
  const account = await seedProfile('walllayer', [
    { serverId: 21, globalItemId: 3000001, positionX: 0, positionY: 5, updatedAt: new Date('2026-08-01T00:00:00Z') },
    { serverId: 22, globalItemId: 3000001, positionX: 0, positionY: 5, updatedAt: new Date('2026-08-02T00:00:00Z') },
  ]);
  const delivered = await getPlayerProfile(account);
  assert.equal(delivered.ownedItems.filter((row) => row.globalItemId === 3000001).length, 2);
});

test('delivery deletes same-position phantoms and keeps the newest row', async () => {
  const account = await seedProfile('koipond', [
    { serverId: 31, globalItemId: 3020123, positionX: 4, positionY: 5, updatedAt: new Date('2026-08-27T22:13:00Z') },
    { serverId: 32, globalItemId: 3020123, positionX: 4, positionY: 5, updatedAt: new Date('2026-08-27T22:23:00Z') },
    { serverId: 33, globalItemId: 3020123, positionX: 4, positionY: 5, updatedAt: new Date('2026-08-27T22:28:00Z') },
    { serverId: 34, globalItemId: 3040001, positionX: 6, positionY: 8, updatedAt: new Date('2026-08-27T22:28:00Z') },
  ]);
  const delivered = await getPlayerProfile(account);
  assert.equal(delivered.ownedItems.filter((row) => row.globalItemId === 3020123).length, 1, 'two Koi Pond phantoms were deleted');
  assert.equal(delivered.ownedItems.find((row) => row.globalItemId === 3020123).serverId, 33, 'the newest Koi Pond survives');
  assert.equal(delivered.ownedItems.filter((row) => row.globalItemId === 3040001).length, 1, 'unrelated items are untouched');
});

test('avatar wardrobe rows are exempt from phantom cleanup', async () => {
  const account = await seedProfile('wardrobe', [
    { serverId: 41, globalItemId: 1040005, positionX: 0, positionY: 0, updatedAt: new Date('2026-08-01T00:00:00Z') },
    { serverId: 42, globalItemId: 1040005, positionX: 0, positionY: 0, updatedAt: new Date('2026-08-02T00:00:00Z') },
  ]);
  const delivered = await getPlayerProfile(account);
  assert.equal(delivered.ownedItems.filter((row) => row.globalItemId === 1040005).length, 2, 'avatar duplicates are never auto-deleted');
});

test('two employees can wear the same avatar item without stealing each other uniforms', async () => {
  const account = await seedProfile('uniforms', []);
  const current = await readOwnerProfile(account);
  await savePlayerProfile(
    savedProfile(current, account),
    emptyAudit({
      saveVersion: current.saveVersion,
      timeOnClient: 25_000,
      upsertOwnedItems: [
        item(-1, 1040005, 0, 0, 0, { network: 2, networkUid: 'employee-a', playfishUid: 1 }),
        item(-2, 1040005, 0, 0, 0, { network: 2, networkUid: 'employee-b', playfishUid: 2 }),
      ],
    }),
  );
  const shirts = (await ownedRows(account.networkUid)).filter((row) => row.globalItemId === 1040005);
  assert.equal(shirts.length, 2);
  assert.deepEqual(shirts.map((row) => row.employeeNetworkUid).sort(), ['employee-a', 'employee-b']);
});

test('selecting a new recipe creates it at level 1, never level 0', async () => {
  const account = await seedProfile('waterrecipe', []);
  const current = await readOwnerProfile(account);
  await savePlayerProfile(
    savedProfile(current, account),
    emptyAudit({
      saveVersion: current.saveVersion,
      timeOnClient: 30_000,
      inventoryChanges: [{ globalItemId: 5300000, delta: 0, selected: true }],
    }),
  );
  const water = await prisma.inventoryItem.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: `facebook:${account.networkUid}`, globalItemId: 5300000 } },
  });
  assert.equal(water?.number, 1);
  assert.equal(water?.isSelected, true);
});

test('the shipped Dummy0 fallback cannot overwrite a real owner profile', async () => {
  const account = await seedProfile('fallbackguard', []);
  await prisma.userProfile.update({
    where: { networkUid: account.networkUid },
    data: { restaurantName: 'Real Restaurant', userLevel: 24, gourmetPoint: 1_731_613, trashPoint: 9 },
  });
  const current = await readOwnerProfile(account);
  await savePlayerProfile(
    savedProfile(current, account, { restaurantName: 'Dummy0', userLevel: 11, gourmetPoint: 10_000, trashPoint: 0 }),
    emptyAudit({ saveVersion: current.saveVersion, timeOnClient: 35_000 }),
  );
  const stored = await readOwnerProfile(account);
  assert.equal(stored.restaurantName, 'Real Restaurant');
  assert.equal(stored.userLevel, 24);
  assert.equal(stored.gourmetPoint, 1_731_613);
  assert.equal(stored.trashPoint, 9);
});

test('an authenticated fallback identity cannot apply its default-world audit', async () => {
  const account = await seedProfile('fallbackpayload', [item(41, 3040001, 8, 8)]);
  const before = await readOwnerProfile(account);
  const result = await savePlayerProfile(
    savedProfile(before, account, {
      restaurantName: 'Dummy0',
      gourmetPoint: 10_000,
      userLevel: 11,
    }),
    emptyAudit({
      removeOwnedItemIds: [41],
      upsertOwnedItems: [item(42, 3040002, 2, 2)],
      floorChanges: [{ floorIndex: 0, tiles: [3040002] }],
    }),
    { fallbackProfile: true },
  );
  assert.equal(result.status, 'saved');
  const after = await readOwnerProfile(account);
  assert.equal(after.restaurantName, before.restaurantName);
  assert.deepEqual((await ownedRows(account.networkUid)).map((row) => row.serverId), [41]);
  assert.deepEqual((await prisma.restaurantFloor.findMany({ where: { userProfileId: `facebook:${account.networkUid}` }, orderBy: { floorIndex: 'asc' } })).map((row) => row.floorIndex), [0, 1]);
});

test('an already-corrupted Dummy0 profile recovers scalar progress from its clean snapshot', async () => {
  const account = await seedProfile('fallbackrepair', []);
  await prisma.userProfile.update({
    where: { networkUid: account.networkUid },
    data: { restaurantName: 'Recovered Restaurant', userLevel: 23, gourmetPoint: 900_000, credits: 50_000 },
  });
  await captureProfileSnapshot(account.networkUid, 'TEST_CLEAN', 'Before simulated fallback corruption');
  await prisma.userProfile.update({
    where: { networkUid: account.networkUid },
    data: { restaurantName: 'Dummy0', userLevel: 11, gourmetPoint: 10_000, credits: 47_500 },
  });

  const recovered = await readOwnerProfile(account);
  assert.equal(recovered.restaurantName, 'Recovered Restaurant');
  assert.equal(recovered.userLevel, 23);
  assert.equal(recovered.gourmetPoint, 900_000);
  assert.equal(recovered.credits, 47_500, 'post-corruption coin state remains untouched');
  assert.equal(await prisma.profileSnapshot.count({ where: { networkUid: account.networkUid, reason: 'AUTO_BEFORE_FALLBACK_RECOVERY' } }), 1);
});

test('fallback recovery recognizes a Dummy save after it earned GP and preserves only later real gain', async () => {
  const account = await seedProfile('fallback10100', []);
  await prisma.userProfile.update({
    where: { networkUid: account.networkUid },
    data: { restaurantName: 'Before Dummy', userLevel: 4, gourmetPoint: 4_350, credits: 5_058 },
  });
  const snapshotId = await captureProfileSnapshot(account.networkUid, 'TEST_CLEAN', 'Before 10,100 GP fallback');
  await prisma.userProfile.update({
    where: { networkUid: account.networkUid },
    data: { restaurantName: 'Dummy0', userLevel: 11, gourmetPoint: 10_175, credits: 5_000 },
  });
  await recordAcceptedSaveTx(prisma, {
    networkUid: account.networkUid,
    saveVersion: 2,
    clientTime: 20_000,
    previousCredits: 5_058,
    credits: 5_000,
    previousGourmet: 4_350,
    gourmetPoint: 10_100,
    previousLevel: 4,
    userLevel: 11,
    audit: emptyAudit({ actionCount: 1, actionTypeCounts: { 17: 1 } }),
    snapshotId,
    acceptedAt: new Date('2026-08-30T04:19:46Z'),
    rpcSessionToken: 'fallback-session',
  });

  const recovered = await getPlayerProfile(account);
  assert.equal(recovered.restaurantName, 'Before Dummy');
  assert.equal(recovered.userLevel, 4);
  assert.equal(recovered.gourmetPoint, 4_425, '75 GP earned after the fallback is retained');
  assert.equal(recovered.credits, 5_000, 'post-corruption coin state remains untouched');
});

test('admin fallback repair preserves every gameplay collection and records the repair', async () => {
  const account = await seedProfile('fallbackbutton', [
    { serverId: 42, globalItemId: 3040001, positionX: 7, positionY: 8, roomIndex: 1 },
  ]);
  await prisma.inventoryItem.create({ data: { id: `facebook:${account.networkUid}:inventory:5300000`, userProfileId: `facebook:${account.networkUid}`, globalItemId: 5300000, number: 4, isSelected: true } });
  await prisma.ingredientInventory.create({ data: { id: `facebook:${account.networkUid}:ingredient:4000001`, userProfileId: `facebook:${account.networkUid}`, globalItemId: 4000001, number: 9, isLocked: true } });
  await captureProfileSnapshot(account.networkUid, 'TEST_CLEAN', 'Button repair baseline');
  await prisma.userProfile.update({ where: { networkUid: account.networkUid }, data: { restaurantName: 'Dummy0', userLevel: 11, gourmetPoint: 10_000 } });

  const result = await repairFallbackPlayer(account.networkUid, { id: 'admin-id', username: 'admin', networkUid: 'admin', role: 'ADMIN' });
  const repaired = await readOwnerProfile(account);
  assert.equal(result.recovered, true);
  assert.equal(repaired.restaurantName, "fallbackbutton's Restaurant");
  assert.equal(repaired.userLevel, 6);
  assert.equal(repaired.ownedItems.length, 1);
  assert.equal(repaired.inventoryItems[0].number, 4);
  assert.equal(repaired.ingredients[0].number, 9);
  assert.equal(await prisma.moderationAction.count({ where: { targetNetworkUid: account.networkUid, actionType: 'REPAIR_FALLBACK_PROFILE' } }), 1);
});

test('profile delivery removes locked zero-count ingredients instead of rendering ghost rows', async () => {
  const account = await seedProfile('emptyingredient', []);
  await prisma.ingredientInventory.create({ data: {
    id: `facebook:${account.networkUid}:ingredient:4000061`,
    userProfileId: `facebook:${account.networkUid}`,
    globalItemId: 4000061,
    number: 0,
    isLocked: true,
  } });
  const profile = await getPlayerProfile(account);
  assert.equal(profile.ingredients.some((ingredient) => ingredient.globalItemId === 4000061), false);
  assert.equal(await prisma.ingredientInventory.count({ where: { userProfileId: `facebook:${account.networkUid}`, globalItemId: 4000061 } }), 0);
});

test('moderation clocks compare only within one fence token and ignore sub-15s noise', async () => {
  const account = await seedProfile('clockguard', []);
  const tx = prisma;
  const evidence = (saveVersion, clientTime, rpcSessionToken, acceptedAt) => ({
    networkUid: account.networkUid,
    saveVersion,
    clientTime,
    previousCredits: 1000,
    credits: 1000,
    previousGourmet: 0,
    gourmetPoint: 0,
    previousLevel: 1,
    userLevel: 1,
    audit: emptyAudit({ actionCount: 1, unknownActionCount: 0, actionTypeCounts: {} }),
    snapshotId: `snap-${saveVersion}-${rpcSessionToken}`,
    acceptedAt,
    rpcSessionToken,
  });

  await recordAcceptedSaveTx(tx, evidence(1, 273_749, 'session-A', new Date('2026-08-28T10:00:00Z')));
  // New SWF load: new token, clock restarts. No delta may be derived.
  await recordAcceptedSaveTx(tx, evidence(1, 59_423, 'session-B', new Date('2026-08-28T10:01:00Z')));
  // Same token, clock genuinely backwards 29 s: derived and stored.
  await recordAcceptedSaveTx(tx, evidence(2, 30_000, 'session-B', new Date('2026-08-28T10:01:59Z')));

  const facts = await tx.profileSaveFact.findMany({ where: { networkUid: account.networkUid }, orderBy: { id: 'asc' } });
  assert.equal(facts[0].clientDeltaSeconds, 0);
  assert.equal(facts[1].clientDeltaSeconds, 0, 'cross-token comparison is not a reversed clock');
  assert.equal(facts[2].clientDeltaSeconds, -29, 'same-token delta stored in seconds');

  const profile = {
    networkUid: account.networkUid, credits: 1000, cashBalance: 0, userLevel: 1, gourmetPoint: 0,
    activeFloorIndex: 0, createdAt: new Date('2026-08-28T09:00:00Z'),
    ownedItems: [], inventoryItems: [], ingredients: [], gardenPlots: [], employees: [], cashTransactions: [],
  };
  const activity = { totalActiveSeconds: 7200, loginCount: 1, requestCount: 1, saveCount: 3 };
  // Rule level: a 29 s same-token reversal flags.
  assert.equal(evaluateProfile(profile, activity, { ...facts[2] }, new Date()).some((f) => f.ruleId === 'CLIENT_TIME_REVERSED'), true);
  // A 5 s reversal is timer noise and does not flag.
  assert.equal(evaluateProfile(profile, activity, { ...facts[2], clientDeltaSeconds: -5 }, new Date()).some((f) => f.ruleId === 'CLIENT_TIME_REVERSED'), false);
});
