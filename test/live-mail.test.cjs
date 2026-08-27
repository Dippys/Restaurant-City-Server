const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.live-mail-test-${process.pid}.db`;
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
const { createAdminMails, listEnabledAccountNetworkUids } = require('../dist/db/admin-store.js');
const { enqueueLiveMail, pollLiveEvents, touchOnline } = require('../dist/live-events.js');

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

async function seedPlayer(uid, username, disabled = false) {
  await prisma.account.create({
    data: {
      id: `account-${uid}`, username, usernameKey: username.toLowerCase(), firstName: username,
      lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: uid,
      playfishUid: Number(uid), disabled,
    },
  });
  await prisma.userProfile.create({
    data: {
      id: `facebook:${uid}`, networkUid: uid, playfishUid: Number(uid),
      firstName: username, fullName: `${username} Chef`, restaurantName: `${username}'s Restaurant`,
    },
  });
}

test('mail invalidations share event polling and coalesce queued mailbox reloads', () => {
  const account = { username: 'online', networkUid: '70001', playfishUid: 70001 };
  touchOnline(account);
  assert.equal(enqueueLiveMail(account.networkUid, 1), true);
  assert.equal(enqueueLiveMail(account.networkUid, 13), true);
  const events = pollLiveEvents(account, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 2);
  assert.deepEqual([...events[0].body], [13]);
});

test('admin fan-out validates layouts, grants rewards, and targets enabled accounts only', async () => {
  await prisma.userProfile.create({
    data: { id: 'facebook:1', networkUid: '1', playfishUid: 1, firstName: 'Restaurant City', fullName: 'Restaurant City', restaurantName: 'Restaurant City' },
  });
  await seedPlayer('70002', 'Enabled');
  await seedPlayer('70003', 'Disabled', true);
  touchOnline({ username: 'Enabled', networkUid: '70002', playfishUid: 70002 });

  assert.deepEqual(await listEnabledAccountNetworkUids(), ['70002']);
  const result = await createAdminMails({
    recipientNetworkUids: ['70002'], senderNetworkUid: '1', type: 4,
    message: 'A gift', globalItemIds: [4000040],
  });
  assert.deepEqual(result, { created: 1, liveNotified: 1 });
  assert.equal(await prisma.mail.count({ where: { recipientNetworkUid: '70002', type: 4 } }), 1);
  assert.equal((await prisma.ingredientInventory.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: 'facebook:70002', globalItemId: 4000040 } },
  })).number, 1);

  const cashBefore = (await prisma.userProfile.findUnique({ where: { id: 'facebook:70002' } })).cashBalance;
  const cashResult = await createAdminMails({
    recipientNetworkUids: ['70002'], senderNetworkUid: '1', type: 7,
    message: 'PFC:25', globalItemIds: [],
  });
  assert.deepEqual(cashResult, { created: 1, liveNotified: 1 });
  assert.equal((await prisma.userProfile.findUnique({ where: { id: 'facebook:70002' } })).cashBalance, cashBefore + 25);
  assert.equal(await prisma.mail.count({ where: { recipientNetworkUid: '70002', type: 7, message: 'PFC:25' } }), 1);

  await assert.rejects(
    createAdminMails({ recipientNetworkUids: ['70002'], senderNetworkUid: '1', type: 6, globalItemIds: [4000040] }),
    /exactly two ingredient ids/,
  );
});
