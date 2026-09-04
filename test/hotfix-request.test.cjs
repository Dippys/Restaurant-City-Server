const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.hotfix-request-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`], {
  cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8',
});
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;

const { prisma } = require('../dist/db/client.js');
const { loadConfig } = require('../dist/config.js');
const { createEntry, createServer } = require('../dist/http-server.js');
const { resolveRequestContext } = require('../dist/request-context.js');
const { hashSessionToken } = require('../dist/session.js');

const tokens = {
  user: 'u'.repeat(43), admin: 'a'.repeat(43), expired: 'e'.repeat(43), disabled: 'd'.repeat(43),
};

test.before(async () => {
  const future = new Date(Date.now() + 60_000);
  await prisma.account.createMany({ data: [
    { id: 'user', username: 'userchef', usernameKey: 'userchef', firstName: 'User', lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: '70001', playfishUid: 70001 },
    { id: 'admin', username: 'adminchef', usernameKey: 'adminchef', firstName: 'Admin', lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: '70002', playfishUid: 70002, role: 'ADMIN' },
    { id: 'expired', username: 'expiredchef', usernameKey: 'expiredchef', firstName: 'Expired', lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: '70003', playfishUid: 70003 },
    { id: 'disabled', username: 'disabledchef', usernameKey: 'disabledchef', firstName: 'Disabled', lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: '70004', playfishUid: 70004, disabled: true },
  ] });
  await prisma.session.createMany({ data: [
    { id: 's-user', tokenHash: hashSessionToken(tokens.user), csrfToken: 'c-user', accountId: 'user', expiresAt: future },
    { id: 's-admin', tokenHash: hashSessionToken(tokens.admin), csrfToken: 'c-admin', accountId: 'admin', expiresAt: future },
    { id: 's-expired', tokenHash: hashSessionToken(tokens.expired), csrfToken: 'c-expired', accountId: 'expired', expiresAt: new Date(Date.now() - 1000) },
    { id: 's-disabled', tokenHash: hashSessionToken(tokens.disabled), csrfToken: 'c-disabled', accountId: 'disabled', expiresAt: future },
  ] });
});

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('production capture defaults are lightweight and development keeps full debugging', () => {
  const saved = { nodeEnv: process.env.NODE_ENV, pepper: process.env.RC_PIN_PEPPER };
  delete process.env.RC_RPC_CAPTURE_MODE;
  delete process.env.RC_REQUEST_LOG_STDOUT;
  delete process.env.MAX_LOG_ENTRIES;
  process.env.NODE_ENV = 'production';
  process.env.RC_PIN_PEPPER = 'test-only';
  const production = loadConfig();
  assert.equal(production.rpcCaptureMode, 'metadata');
  assert.equal(production.requestLogStdout, false);
  assert.equal(production.maxLogEntries, 50);
  assert.equal(production.activityFlushIntervalSeconds, 60);
  assert.equal(production.autoSaveSnapshotIntervalMinutes, 60);
  process.env.NODE_ENV = 'development';
  assert.equal(loadConfig().rpcCaptureMode, 'full');
  if (saved.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.nodeEnv;
  if (saved.pepper === undefined) delete process.env.RC_PIN_PEPPER; else process.env.RC_PIN_PEPPER = saved.pepper;
});

test('metadata capture omits expensive encodings and full capture redacts secrets', () => {
  const headers = { cookie: 'rc_session=super-secret', authorization: 'Bearer secret', 'x-csrf-token': 'csrf', accept: 'application/octet-stream' };
  const req = { method: 'POST', url: '/g/rpc/cooking?token=secret&safe=yes', headers };
  const url = new URL(`http://local${req.url}`);
  const rpcBody = Buffer.from([0, 254, 3, 97, 98, 99, 9, 8, 7]);
  const metadata = createEntry(1, req, url, url.pathname, rpcBody, 'metadata');
  assert.equal(metadata.bodyLen, rpcBody.length);
  for (const field of ['headers', 'query', 'rawUrl', 'bodyHex', 'bodyBase64', 'bodyText']) assert.equal(Object.hasOwn(metadata, field), false, field);

  const full = createEntry(2, req, url, url.pathname, rpcBody, 'full');
  assert.equal(full.headers.cookie, '[redacted]');
  assert.equal(full.headers.authorization, '[redacted]');
  assert.equal(full.headers['x-csrf-token'], '[redacted]');
  assert.deepEqual(full.query, { token: '[redacted]', safe: 'yes' });
  assert.equal(full.bodyHex.includes(Buffer.from('abc').toString('hex')), false, 'RPC session bytes must be overwritten before encoding');
  assert.equal(full.bodyHex.includes(Buffer.from('***').toString('hex')), true);

  const login = createEntry(3, { method: 'POST', url: '/__api/login', headers: {} }, new URL('http://local/__api/login'), '/__api/login', Buffer.from('{"pin":"123456"}'), 'full');
  assert.equal(login.bodyText, undefined);
  assert.equal(login.bodyHex, undefined);
});

test('request context resolves normal authentication exactly once', async () => {
  let calls = 0;
  const account = { id: 'one', username: 'once', networkUid: '1', playfishUid: 1 };
  const req = { headers: {} };
  const context = await resolveRequestContext(7, req, async () => { calls += 1; return account; });
  assert.equal(context.account, account);
  assert.equal(await context.gameAccount(), account);
  assert.equal(await context.gameAccount(), account);
  assert.equal(calls, 1);
  assert.equal('rawToken' in context, false);
});

test('authenticated, anonymous, expired, disabled, and admin HTTP behavior is preserved', async () => {
  const server = createServer({ ...loadConfig(), port: 0, host: '127.0.0.1', requestLogStdout: false, rpcCaptureMode: 'metadata' });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const session = (token) => fetch(`${origin}/__api/session`, { headers: token ? { cookie: `rc_session=${token}` } : {} }).then((response) => response.json());
  try {
    assert.equal((await session(tokens.user)).account.networkUid, '70001');
    assert.equal((await session()).loggedIn, false);
    assert.equal((await session(tokens.expired)).loggedIn, false);
    assert.equal((await session(tokens.disabled)).loggedIn, false);
    assert.equal((await fetch(`${origin}/__api/admin/overview`)).status, 401);
    assert.equal((await fetch(`${origin}/__api/admin/overview`, { headers: { cookie: `rc_session=${tokens.user}` } })).status, 403);
    const overviewResponse = await fetch(`${origin}/__api/admin/overview`, { headers: { cookie: `rc_session=${tokens.admin}` } });
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json();
    assert.equal(overview.performance.requestCount >= 6, true);
    assert.equal(overview.performance.activeRequests >= 1, true);
    assert.equal(typeof overview.performance.memory.rssBytes, 'number');
    assert.equal(typeof overview.performance.eventLoopDelayMs.p99, 'number');
    assert.deepEqual(Object.keys(overview.performance.rpcLatency), []);
  } finally {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
});
