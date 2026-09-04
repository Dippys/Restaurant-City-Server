const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.query-parameter-batching-test-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env };
delete pushEnv.RC_DB_PATH;
const push = spawnSync(
  process.execPath,
  [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`],
  { cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8' },
);
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;

const { prisma } = require('../dist/db/client.js');
const { listAdminUsers } = require('../dist/db/admin-store.js');
const { getProfiles } = require('../dist/db/profile-store.js');
const { hireCandidates } = require('../dist/db/rpc-store.js');

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('large profile rosters are hydrated in bounded query batches', async () => {
  const profileCount = 1_205;
  const networkUids = Array.from({ length: profileCount }, (_, index) => String(900_000 + index));
  await prisma.userProfile.createMany({
    data: networkUids.map((networkUid) => ({
      id: `facebook:${networkUid}`,
      networkUid,
      playfishUid: Number(networkUid),
      firstName: `Chef${networkUid}`,
      fullName: `Chef ${networkUid}`,
      restaurantName: `Restaurant ${networkUid}`,
    })),
  });

  const profiles = await getProfiles(networkUids, '');
  assert.equal(profiles.length, profileCount);
  assert.deepEqual(profiles.map((profile) => profile.networkUid), [...networkUids].sort());

  const firstPage = await listAdminUsers(1, 50);
  assert.equal(firstPage.users.length, 50);
  assert.equal(firstPage.total, profileCount);
  assert.equal(firstPage.totalPages, 25);
  assert.deepEqual(firstPage.users.map((profile) => profile.networkUid), [...networkUids].sort().slice(0, 50));

  const lastPage = await listAdminUsers(25, 50);
  assert.equal(lastPage.users.length, 5);
  assert.equal(lastPage.page, 25);

  const searchedPage = await listAdminUsers(1, 50, networkUids[600]);
  assert.equal(searchedPage.total, 1);
  assert.equal(searchedPage.users[0].networkUid, networkUids[600]);

  const rosterUids = networkUids.slice(0, 26);
  await prisma.account.createMany({ data: rosterUids.map((networkUid) => ({
    id: `account-${networkUid}`,
    username: `user${networkUid}`,
    usernameKey: `user${networkUid}`,
    firstName: `Chef${networkUid}`,
    lastName: 'Player',
    pinHash: 'x',
    pinSalt: 'x',
    networkUid,
    playfishUid: Number(networkUid),
  })) });
  const ownerUid = rosterUids[0];
  const employerUid = rosterUids[25];
  const recentUid = rosterUids[24];
  await prisma.employee.create({ data: {
    id: `facebook:${employerUid}:employee:${ownerUid}`,
    userProfileId: `facebook:${employerUid}`,
    networkUid: ownerUid,
  } });
  await prisma.playerActivity.create({ data: {
    accountId: `account-${recentUid}`,
    networkUid: recentUid,
    lastSeenAt: new Date(),
  } });

  const candidates = await hireCandidates({
    id: `account-${ownerUid}`,
    username: `user${ownerUid}`,
    networkUid: ownerUid,
    playfishUid: Number(ownerUid),
  }, 100);
  assert.equal(candidates.length, 20);
  assert.equal(candidates[0].networkUid, employerUid);
  assert.equal(candidates[1].networkUid, recentUid);
});
