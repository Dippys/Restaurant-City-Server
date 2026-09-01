const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.discord-notification-cycle-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`], {
  cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8',
});
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;
process.env.RC_DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.RC_PUBLIC_ORIGIN = 'https://rc-reborn.uk';

const originalFetch = global.fetch;
const sentMessages = [];
global.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/users/@me/channels')) return new Response(JSON.stringify({ id: 'dm-channel' }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/channels/dm-channel/messages')) {
    sentMessages.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: String(sentMessages.length) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

const { prisma } = require('../dist/db/client.js');
const { runDiscordNotificationCycle } = require('../dist/discord-notifications.js');

test.after(async () => {
  global.fetch = originalFetch;
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('notification cycle sends all new mail and edge-triggered employee/garden alerts once', async () => {
  const now = new Date('2026-09-01T12:00:00.000Z');
  await prisma.account.create({ data: {
    id: 'notify-account', username: 'notifychef', usernameKey: 'notifychef', firstName: 'Notify', lastName: 'Chef',
    pinHash: 'test', pinSalt: 'test', networkUid: '799000001', playfishUid: 799000001,
    discordIdentity: { create: { discordUserId: '123456789012345678', username: 'notifydiscord', globalName: 'Notify Chef' } },
  } });
  await prisma.userProfile.create({ data: {
    id: 'facebook:799000001', networkUid: '799000001', playfishUid: 799000001, firstName: 'Notify', fullName: 'Notify Chef', restaurantName: 'Notify Kitchen',
    employees: { create: [{ id: 'employee-1', networkUid: '799000002', happiness: 10 }] },
    gardenPlots: { create: [{ id: 'plot-1', plotId: 0, ingredientId: 4000040, plantWetTime: 0, timeToDry: 3600, createdAt: now, updatedAt: now }] },
  } });
  await prisma.userProfile.create({ data: {
    id: 'facebook:799000003', networkUid: '799000003', playfishUid: 799000003, firstName: 'Mia', fullName: 'Mia Stone', restaurantName: 'Mia’s Kitchen',
  } });

  await runDiscordNotificationCycle(now);
  assert.equal(sentMessages.length, 0, 'first cycle should baseline existing state');

  await prisma.mail.create({ data: {
    senderProfileId: 'facebook:799000003', recipientProfileId: 'facebook:799000001', senderNetworkUid: '799000003', senderPlayfishUid: 799000003,
    recipientNetworkUid: '799000001', recipientPlayfishUid: 799000001, message: 'Dinner rush starts soon!', sendDate: Math.floor(now.getTime() / 1000), type: 1,
  } });
  await prisma.employee.update({ where: { id: 'employee-1' }, data: { happiness: 0 } });
  await runDiscordNotificationCycle(new Date(now.getTime() + 4000_000));
  assert.deepEqual(sentMessages.map((message) => message.embeds[0].title), [
    'A chef sent you a message! 💌',
    'Your staff need a break! 😴',
    'Your garden is thirsty! 💧',
  ]);

  await runDiscordNotificationCycle(new Date(now.getTime() + 4000_000));
  assert.equal(sentMessages.length, 3, 'unchanged state must not duplicate alerts');

  await prisma.gardenPlot.update({ where: { id: 'plot-1' }, data: { createdAt: new Date(now.getTime() - 49 * 3600_000), updatedAt: now, timeToDry: 3600 } });
  await runDiscordNotificationCycle(now);
  assert.equal(sentMessages.at(-1).embeds[0].title, 'Your garden is ready to harvest! 🌾');
});
