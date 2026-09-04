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

  const adminUsers = await listAdminUsers();
  assert.equal(adminUsers.length, profileCount);
  assert.deepEqual(adminUsers.map((profile) => profile.networkUid), [...networkUids].sort());
});
