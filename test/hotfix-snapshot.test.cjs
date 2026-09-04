const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.hotfix-snapshot-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`], {
  cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8',
});
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;

const { prisma } = require('../dist/db/client.js');
const { savePlayerProfile } = require('../dist/db/profile-store.js');
const { configureAutomaticSnapshotInterval } = require('../dist/moderation/service.js');
const { captureProfileSnapshot, rollbackProfile } = require('../dist/moderation/snapshots.js');

const admin = { id: 'admin', username: 'adminchef', networkUid: '72000', playfishUid: 72000, role: 'ADMIN' };

test.before(async () => {
  configureAutomaticSnapshotInterval(60);
  await prisma.account.create({ data: { id: admin.id, username: admin.username, usernameKey: admin.username, firstName: 'Admin', lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: admin.networkUid, playfishUid: admin.playfishUid, role: 'ADMIN' } });
});

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

async function seed(id, uid) {
  await prisma.account.create({ data: { id, username: id, usernameKey: id, firstName: id, lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: uid, playfishUid: Number(uid) } });
  await prisma.userProfile.create({ data: { id: `facebook:${uid}`, networkUid: uid, playfishUid: Number(uid), firstName: id, fullName: `${id} Chef`, restaurantName: `${id}'s Restaurant`, userLevel: 1, gourmetPoint: 0, demandPoint: 120, musicPlay: 0 } });
  const sessionId = `session-${id}`;
  const rpcSessionToken = `rpc-${id}`;
  await prisma.session.create({ data: { id: sessionId, tokenHash: `hash-${id}`, csrfToken: `csrf-${id}`, accountId: id, expiresAt: new Date('2035-01-01T00:00:00Z'), rpcSessionToken } });
  return { id, username: id, networkUid: uid, playfishUid: Number(uid), sessionId, rpcSessionToken };
}

function profile(account, gourmetPoint) {
  return {
    id: { network: 2, networkUid: account.networkUid, playfishUid: account.playfishUid },
    restaurantName: `${account.username}'s Restaurant`, gourmetPoint, trashPoint: 0, demandPoint: 120,
    musicPlay: 0, isInStreet: false, awards: null, userLevel: 1, activeFloorIndex: 0,
  };
}

function audit(saveVersion, timeOnClient) {
  return {
    saveVersion, timeOnClient, creditDelta: 0, newCredits: null,
    upsertOwnedItems: [], removeOwnedItemIds: [], inventoryChanges: [], bulkInventoryMoves: [],
    ingredientChanges: [], lockIngredientChanges: [], gardenChanges: [], floorChanges: [], employeeChanges: [],
    openMailIds: [], deleteMailIds: [], visitedFriends: [], actionCount: 0, unknownActionCount: 0, actionTypeCounts: {},
  };
}

function fence(account, digest) {
  return { authSessionId: account.sessionId, rpcSessionToken: account.rpcSessionToken, payloadDigest: digest };
}

test('automatic pre-save checkpoints are hourly per player while every accepted save keeps a fact', async () => {
  const alpha = await seed('alpha', '72001');
  const beta = await seed('beta', '72002');

  assert.deepEqual(await savePlayerProfile(profile(alpha, 100), audit(1, 1000), fence(alpha, 'a1')), { status: 'saved', savedVersion: 1 });
  assert.deepEqual(await savePlayerProfile(profile(alpha, 200), audit(2, 2000), fence(alpha, 'a2')), { status: 'saved', savedVersion: 2 });
  let alphaSnapshots = await prisma.profileSnapshot.findMany({ where: { networkUid: alpha.networkUid, reason: 'ACCEPTED_SAVE_BEFORE' }, orderBy: { createdAt: 'asc' } });
  let alphaFacts = await prisma.profileSaveFact.findMany({ where: { networkUid: alpha.networkUid }, orderBy: { createdAt: 'asc' } });
  assert.equal(alphaSnapshots.length, 1, 'repeated saves inside the interval reuse the first checkpoint');
  assert.equal(alphaFacts.length, 2, 'each accepted save keeps compact evidence');
  assert.equal(alphaFacts[0].snapshotId, alphaSnapshots[0].id);
  assert.equal(alphaFacts[1].snapshotId, alphaSnapshots[0].id, 'the fact points to its interval checkpoint, not a fictitious exact pre-save state');

  assert.deepEqual(await savePlayerProfile(profile(beta, 50), audit(1, 1000), fence(beta, 'b1')), { status: 'saved', savedVersion: 1 });
  assert.equal(await prisma.profileSnapshot.count({ where: { networkUid: beta.networkUid, reason: 'ACCEPTED_SAVE_BEFORE' } }), 1, 'players throttle independently');

  await prisma.profileSnapshot.update({ where: { id: alphaSnapshots[0].id }, data: { createdAt: new Date(Date.now() - 61 * 60_000) } });
  assert.deepEqual(await savePlayerProfile(profile(alpha, 300), audit(3, 3000), fence(alpha, 'a3')), { status: 'saved', savedVersion: 3 });
  alphaSnapshots = await prisma.profileSnapshot.findMany({ where: { networkUid: alpha.networkUid, reason: 'ACCEPTED_SAVE_BEFORE' }, orderBy: { createdAt: 'asc' } });
  alphaFacts = await prisma.profileSaveFact.findMany({ where: { networkUid: alpha.networkUid }, orderBy: { createdAt: 'asc' } });
  assert.equal(alphaSnapshots.length, 2, 'a save after the interval creates a new checkpoint');
  assert.equal(alphaFacts.length, 3);
  assert.equal(alphaFacts[2].snapshotId, alphaSnapshots[1].id);

  await captureProfileSnapshot(alpha.networkUid, 'ADMIN_MANUAL', 'Manual one', admin);
  await captureProfileSnapshot(alpha.networkUid, 'ADMIN_MANUAL', 'Manual two', admin);
  assert.equal(await prisma.profileSnapshot.count({ where: { networkUid: alpha.networkUid, reason: 'ADMIN_MANUAL' } }), 2, 'manual/protected reasons are never throttled');

  assert.deepEqual(await savePlayerProfile(profile(alpha, 300), audit(3, 3000), fence(alpha, 'a3')), { status: 'duplicate', savedVersion: 3 });
  assert.deepEqual(await savePlayerProfile(profile(alpha, 250), audit(2, 2500), fence(alpha, 'stale')), { status: 'stale', savedVersion: 3 });
  assert.equal(await prisma.profileSaveFact.count({ where: { networkUid: alpha.networkUid } }), 3);
  assert.equal(await prisma.profileSnapshot.count({ where: { networkUid: alpha.networkUid, reason: 'ACCEPTED_SAVE_BEFORE' } }), 2);

  await rollbackProfile(alpha.networkUid, alphaSnapshots[0].id, admin, 'Verify checkpoint recovery');
  const restored = await prisma.userProfile.findUniqueOrThrow({ where: { networkUid: alpha.networkUid } });
  assert.equal(restored.gourmetPoint, 0, 'rollback restores the interval checkpoint exactly');
});
