const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dbName = `.hotfix-benchmark-${process.pid}.db`;
const dbPath = path.join(root, dbName);
fs.writeFileSync(dbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${dbName}`], { cwd: root, env: pushEnv, encoding: 'utf8' });
if (push.status !== 0) throw new Error(push.stderr || push.stdout);
process.env.RC_DB_PATH = dbPath;

const { prisma } = require('../dist/db/client.js');
const { createEntry } = require('../dist/http-server.js');
const { ActivityBuffer } = require('../dist/activity-buffer.js');
const { savePlayerProfile } = require('../dist/db/profile-store.js');
const { configureAutomaticSnapshotInterval } = require('../dist/moderation/service.js');

function measure(action) {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const value = action();
  const finish = (result) => ({ result, durationMs: performance.now() - started, heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore });
  return value && typeof value.then === 'function' ? value.then(finish) : finish(value);
}

async function captureBenchmark() {
  const iterations = 2000;
  const body = Buffer.alloc(64 * 1024, 0x61);
  body[0] = 0; body[1] = 254; body[2] = 3; body[3] = 97; body[4] = 98; body[5] = 99;
  const req = { method: 'POST', url: '/g/rpc/cooking', headers: { cookie: 'rc_session=secret', authorization: 'Bearer secret' } };
  const url = new URL('http://local/g/rpc/cooking');
  const run = (mode) => measure(() => {
    let encodedBytes = 0;
    for (let index = 0; index < iterations; index += 1) {
      const entry = createEntry(index, req, url, url.pathname, body, mode);
      encodedBytes += Buffer.byteLength(entry.bodyHex || '') + Buffer.byteLength(entry.bodyBase64 || '') + Buffer.byteLength(entry.bodyText || '') + Buffer.byteLength(entry.respHex || '');
    }
    return { encodedBytes };
  });
  return { iterations, bodyBytes: body.length, full: await run('full'), metadata: await run('metadata') };
}

async function activityBenchmark() {
  const iterations = 250;
  await seedAccount('activity', '73001');
  await prisma.playerActivity.create({ data: { accountId: 'activity', networkUid: '73001' } });
  const account = { id: 'activity', username: 'activity', networkUid: '73001', playfishUid: 73001 };
  const legacy = await measure(async () => {
    for (let index = 0; index < iterations; index += 1) {
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        const existing = await tx.playerActivity.findUniqueOrThrow({ where: { accountId: account.id } });
        const gapSeconds = Math.max(0, Math.floor((now.getTime() - existing.lastSeenAt.getTime()) / 1000));
        await tx.playerActivity.update({ where: { accountId: account.id }, data: { lastSeenAt: now, totalActiveSeconds: { increment: Math.min(gapSeconds, 120) }, requestCount: { increment: 1 }, rpcCount: { increment: 1 } } });
      });
    }
  });
  await prisma.playerActivity.update({ where: { accountId: account.id }, data: { requestCount: 0, rpcCount: 0, totalActiveSeconds: 0 } });
  const buffer = new ActivityBuffer(60_000);
  const coalesced = await measure(async () => {
    for (let index = 0; index < iterations; index += 1) buffer.enqueueRpc(account);
    await buffer.flushDue(true);
  });
  return {
    iterations,
    perRpc: { ...legacy, dbReads: iterations, dbWrites: iterations },
    coalesced: { ...coalesced, dbReads: 1, dbWrites: 1 },
  };
}

async function snapshotBenchmark() {
  const saves = 12;
  const legacyAccount = await seedSaveProfile('legacy-save', '73002');
  const throttledAccount = await seedSaveProfile('throttled-save', '73003');
  configureAutomaticSnapshotInterval(0);
  const legacy = await measure(() => runSaves(legacyAccount, saves));
  configureAutomaticSnapshotInterval(60);
  const throttled = await measure(() => runSaves(throttledAccount, saves));
  const [legacySnapshots, throttledSnapshots] = await Promise.all([
    prisma.profileSnapshot.findMany({ where: { networkUid: legacyAccount.networkUid, reason: 'ACCEPTED_SAVE_BEFORE' }, select: { payloadJson: true } }),
    prisma.profileSnapshot.findMany({ where: { networkUid: throttledAccount.networkUid, reason: 'ACCEPTED_SAVE_BEFORE' }, select: { payloadJson: true } }),
  ]);
  return {
    saves,
    withoutThrottle: {
      ...legacy, checkpointLookups: 0, fullProfileSnapshotReads: saves, snapshotWrites: legacySnapshots.length,
      saveFactWrites: saves, snapshotPayloadBytes: legacySnapshots.reduce((sum, row) => sum + Buffer.byteLength(row.payloadJson), 0),
    },
    hourlyThrottle: {
      ...throttled, checkpointLookups: saves, fullProfileSnapshotReads: throttledSnapshots.length,
      snapshotWrites: throttledSnapshots.length, saveFactWrites: saves,
      snapshotPayloadBytes: throttledSnapshots.reduce((sum, row) => sum + Buffer.byteLength(row.payloadJson), 0),
    },
  };
}

async function seedAccount(id, uid) {
  await prisma.account.create({ data: { id, username: id, usernameKey: id, firstName: id, lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: uid, playfishUid: Number(uid) } });
}

async function seedSaveProfile(id, uid) {
  await seedAccount(id, uid);
  await prisma.userProfile.create({ data: {
    id: `facebook:${uid}`, networkUid: uid, playfishUid: Number(uid), firstName: id, fullName: `${id} Chef`, restaurantName: `${id}'s Restaurant`,
    userLevel: 1, gourmetPoint: 0, demandPoint: 120,
    floors: { create: [{ id: `facebook:${uid}:floor:0`, floorIndex: 0, tilesJson: JSON.stringify(Array(800).fill(0)) }] },
  } });
  const sessionId = `session-${id}`;
  const rpcSessionToken = `rpc-${id}`;
  await prisma.session.create({ data: { id: sessionId, tokenHash: `hash-${id}`, csrfToken: 'csrf', accountId: id, expiresAt: new Date('2035-01-01T00:00:00Z'), rpcSessionToken } });
  return { id, username: id, networkUid: uid, playfishUid: Number(uid), sessionId, rpcSessionToken };
}

async function runSaves(account, count) {
  for (let version = 1; version <= count; version += 1) {
    const result = await savePlayerProfile({
      id: { network: 2, networkUid: account.networkUid, playfishUid: account.playfishUid },
      restaurantName: `${account.username}'s Restaurant`, gourmetPoint: version, trashPoint: 0, demandPoint: 120,
      musicPlay: 0, isInStreet: false, awards: null, userLevel: 1, activeFloorIndex: 0,
    }, {
      saveVersion: version, timeOnClient: version * 1000, creditDelta: 0, newCredits: null,
      upsertOwnedItems: [], removeOwnedItemIds: [], inventoryChanges: [], bulkInventoryMoves: [], ingredientChanges: [],
      lockIngredientChanges: [], gardenChanges: [], floorChanges: [], employeeChanges: [], openMailIds: [], deleteMailIds: [],
      visitedFriends: [], actionCount: 0, unknownActionCount: 0, actionTypeCounts: {},
    }, { authSessionId: account.sessionId, rpcSessionToken: account.rpcSessionToken, payloadDigest: `digest-${version}` });
    if (result.status !== 'saved') throw new Error(`save ${version} returned ${result.status}`);
  }
}

(async () => {
  try {
    const result = {
      generatedAt: new Date().toISOString(),
      database: 'disposable generated SQLite fixture',
      capture: await captureBenchmark(),
      activity: await activityBenchmark(),
      snapshots: await snapshotBenchmark(),
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
    fs.rmSync(dbPath, { force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
