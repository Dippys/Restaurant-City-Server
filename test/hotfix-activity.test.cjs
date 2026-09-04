const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.hotfix-activity-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`], {
  cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8',
});
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;

const { prisma } = require('../dist/db/client.js');
const { ActivityBuffer, recordRpcActivity, rpcActivityBuffer } = require('../dist/activity-buffer.js');

test.after(async () => {
  await rpcActivityBuffer.shutdown(1000);
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('RPC activity coalesces counters and active gaps into one persistence call', async () => {
  let now = 1_000_000;
  const batches = [];
  const buffer = new ActivityBuffer(60_000, async (batch) => batches.push(batch), () => now, 120_000);
  const account = { id: 'account-one', username: 'chef', networkUid: '71001', playfishUid: 71001 };
  buffer.enqueueRpc(account);
  now += 30_000;
  buffer.enqueueRpc(account);
  now += 40_000;
  buffer.enqueueRpc(account);
  await buffer.flushDue();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].requestCount, 3);
  assert.equal(batches[0].rpcCount, 3);
  assert.equal(batches[0].activeSecondsBetween, 70);
  assert.equal(buffer.size, 0);
});

test('failed flushes retain counters, do not overlap, and retry successfully', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const batches = [];
  const buffer = new ActivityBuffer(1, async (batch) => {
    calls += 1;
    if (calls === 1) { await gate; throw new Error('temporary'); }
    batches.push(batch);
  });
  const account = { id: 'retry', username: 'retry', networkUid: '71002', playfishUid: 71002 };
  buffer.enqueueRpc(account);
  const first = buffer.flushAccount(account.id);
  const overlap = buffer.flushAccount(account.id);
  buffer.enqueueRpc(account, Date.now() + 1000);
  release();
  await assert.rejects(first, /temporary/);
  await overlap;
  assert.equal(calls, 1, 'the overlapping attempt must skip');
  assert.equal(buffer.size, 1);
  await buffer.flushAccount(account.id);
  assert.equal(batches[0].rpcCount, 2);
  assert.equal(buffer.size, 0);
});

test('idle state is cleaned and shutdown forces a bounded final flush', async () => {
  let now = 10_000;
  const batches = [];
  const buffer = new ActivityBuffer(60_000, async (batch) => batches.push(batch), () => now, 1000);
  const account = { id: 'shutdown', username: 'shutdown', networkUid: '71003', playfishUid: 71003 };
  buffer.enqueueRpc(account);
  assert.equal(await buffer.shutdown(1000), true);
  assert.equal(batches.length, 1);
  assert.equal(buffer.trackedAccounts, 1);
  now += 1001;
  buffer.cleanupIdle();
  assert.equal(buffer.trackedAccounts, 0);
});

test('shutdown waits for an active flush and reports a permanent final-flush failure', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const account = { id: 'inflight-shutdown', username: 'shutdown', networkUid: '71005', playfishUid: 71005 };
  const draining = new ActivityBuffer(1, async () => { calls += 1; await gate; });
  draining.enqueueRpc(account);
  const activeFlush = draining.flushAccount(account.id);
  const shutdown = draining.shutdown(1000);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal(await shutdown, true);
  await activeFlush;
  assert.equal(calls, 1);

  const failing = new ActivityBuffer(1, async () => { throw new Error('database unavailable'); });
  failing.enqueueRpc({ ...account, id: 'failed-shutdown' });
  assert.equal(await failing.shutdown(1000), false);
  assert.equal(failing.size, 1, 'the failed final batch remains available until process exit');
});

test('database persistence uses coalesced atomic increments and poll-path enqueue does not wait for a write', async () => {
  await prisma.account.create({ data: { id: 'db-account', username: 'dbchef', usernameKey: 'dbchef', firstName: 'Db', lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: '71004', playfishUid: 71004 } });
  await prisma.playerActivity.create({ data: { accountId: 'db-account', networkUid: '71004', lastSeenAt: new Date(Date.now() - 30_000), requestCount: 5, rpcCount: 4 } });
  const account = { id: 'db-account', username: 'dbchef', networkUid: '71004', playfishUid: 71004 };
  assert.equal(recordRpcActivity(account), undefined, 'RPC path must only enqueue');
  recordRpcActivity(account);
  const before = await prisma.playerActivity.findUniqueOrThrow({ where: { accountId: account.id } });
  assert.equal(before.rpcCount, 4, 'enqueue must not synchronously write');
  await rpcActivityBuffer.flushDue(true);
  const after = await prisma.playerActivity.findUniqueOrThrow({ where: { accountId: account.id } });
  assert.equal(after.requestCount, 7);
  assert.equal(after.rpcCount, 6);
  assert.equal(after.totalActiveSeconds >= 0, true);
});
