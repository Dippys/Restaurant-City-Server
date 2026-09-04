const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const testDbName = `.leaderboard-http-${process.pid}.db`;
const testDbPath = path.join(root, testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env };
delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`], { cwd: root, env: pushEnv, encoding: 'utf8' });
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;

const { prisma } = require('../dist/db/client.js');
const { loadConfig } = require('../dist/config.js');
const { createServer } = require('../dist/http-server.js');

let server;

test.after(async () => {
  if (server?.httpServer.listening) await new Promise((resolve) => server.httpServer.close(resolve));
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('public leaderboard page and API use a shared cached snapshot', async () => {
  await prisma.account.create({ data: {
    id: 'leader-account', username: 'CacheChef', usernameKey: 'cachechef', firstName: 'Cache', lastName: 'Chef',
    pinHash: 'test', pinSalt: 'test', networkUid: '730001', playfishUid: 730001,
  } });
  await prisma.userProfile.create({ data: {
    id: 'facebook:730001', networkUid: '730001', playfishUid: 730001, firstName: 'Cache', fullName: 'Cache Chef',
    restaurantName: 'The Cached Kitchen', userLevel: 18, gourmetPoint: 123450, nbVote: 10, totalMark: 46, bookmarkCount: 7,
  } });

  server = createServer({ ...loadConfig(), host: '127.0.0.1', port: 0, leaderboardCacheMs: 60_000 });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${origin}/leaderboards`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Gourmet Hall of Fame/);

  const first = await fetch(`${origin}/__api/leaderboards?board=gourmet`);
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-leaderboard-cache'), 'MISS');
  assert.equal(firstBody.entries[0].username, 'CacheChef');
  assert.equal(firstBody.entries[0].rank, 1);

  const second = await fetch(`${origin}/__api/leaderboards?board=gourmet&q=cached`);
  const secondBody = await second.json();
  assert.equal(second.headers.get('x-leaderboard-cache'), 'HIT');
  assert.equal(secondBody.total, 1);
  assert.equal(secondBody.entries[0].restaurantName, 'The Cached Kitchen');
});
