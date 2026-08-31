const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.impersonation-test-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env };
delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`], {
  cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8',
});
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;

const { prisma } = require('../dist/db/client.js');
const { impersonationFromRequest, startImpersonation, stopImpersonation } = require('../dist/impersonation.js');
const { hashSessionToken } = require('../dist/session.js');
const { createServer } = require('../dist/http-server.js');
const { loadConfig } = require('../dist/config.js');

const adminRawToken = 'a'.repeat(43);
const admin = {
  id: 'admin-account', username: 'operator', firstName: 'Admin', lastName: 'User',
  networkUid: '900001', playfishUid: 900001, role: 'ADMIN', csrfToken: 'admin-csrf', sessionId: 'admin-session',
};

test.before(async () => {
  await prisma.account.createMany({ data: [
    { id: admin.id, username: admin.username, usernameKey: admin.username, firstName: 'Admin', lastName: 'User', pinHash: 'x', pinSalt: 'x', networkUid: admin.networkUid, playfishUid: admin.playfishUid, role: 'ADMIN' },
    { id: 'target-account', username: 'target', usernameKey: 'target', firstName: 'Target', lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: '900002', playfishUid: 900002 },
  ] });
  await prisma.session.createMany({ data: [
    { id: admin.sessionId, tokenHash: hashSessionToken(adminRawToken), csrfToken: admin.csrfToken, accountId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
    { id: 'target-real-session', tokenHash: 'target-real-token', csrfToken: 'target-real-csrf', accountId: 'target-account', expiresAt: new Date(Date.now() + 60_000) },
  ] });
});

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('impersonation is admin-bound, audited, short-lived, and preserves the player session', async () => {
  const started = await startImpersonation(admin, '900002', '127.0.0.1', 'test-agent');
  assert.equal(started.account.networkUid, '900002');
  assert.ok(new Date(started.expiresAt).getTime() <= Date.now() + 30 * 60 * 1000);
  assert.equal(await prisma.session.count({ where: { accountId: 'target-account' } }), 2);

  const request = { headers: { cookie: `rc_session=${adminRawToken}; rc_impersonation=${started.rawToken}` } };
  const resolved = await impersonationFromRequest(request);
  assert.equal(resolved.present, true);
  assert.equal(resolved.account.networkUid, '900002');
  assert.equal(resolved.actorUsername, admin.username);

  const missingAdmin = await impersonationFromRequest({ headers: { cookie: `rc_impersonation=${started.rawToken}` } });
  assert.equal(missingAdmin.present, true);
  assert.equal(missingAdmin.account, null);

  await stopImpersonation(request, admin);
  assert.equal(await prisma.session.count({ where: { accountId: 'target-account' } }), 1);
  assert.deepEqual(
    (await prisma.moderationAction.findMany({ where: { targetNetworkUid: '900002' }, orderBy: { createdAt: 'asc' } })).map((action) => action.actionType),
    ['IMPERSONATION_START', 'IMPERSONATION_STOP'],
  );
});

test('non-admin actors cannot start impersonation', async () => {
  await assert.rejects(
    startImpersonation({ ...admin, id: 'target-account', networkUid: '900002', role: 'USER' }, admin.networkUid, '', ''),
    /Administrator access required/,
  );
});

test('HTTP handoff keeps admin APIs separate from the impersonated game identity', async () => {
  const server = createServer({ ...loadConfig(), port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const adminCookie = `rc_session=${adminRawToken}`;
  try {
    const started = await fetch(`${origin}/__api/admin/impersonation`, {
      method: 'POST',
      headers: { cookie: adminCookie, origin, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ networkUid: '900002' }),
    });
    assert.equal(started.status, 200);
    const startedBody = await started.json();
    assert.equal(startedBody.account.networkUid, '900002');
    const setCookie = started.headers.get('set-cookie');
    assert.match(setCookie, /^rc_impersonation=/);
    const impersonationCookie = setCookie.split(';', 1)[0];
    const gameCookie = `${adminCookie}; ${impersonationCookie}`;

    const adminSession = await fetch(`${origin}/__api/session`, { headers: { cookie: gameCookie } });
    assert.equal((await adminSession.json()).account.networkUid, admin.networkUid);
    const gameSession = await fetch(`${origin}/__api/session`, { headers: { cookie: gameCookie, 'x-rc-game-session': '1' } });
    const gameBody = await gameSession.json();
    assert.equal(gameBody.account.networkUid, '900002');
    assert.equal(gameBody.impersonating, true);
    assert.equal((await fetch(`${origin}/game`, { headers: { cookie: gameCookie } })).status, 200);

    const stopped = await fetch(`${origin}/__api/game/impersonation`, {
      method: 'DELETE',
      headers: { cookie: gameCookie, origin, 'x-csrf-token': gameBody.csrfToken },
    });
    assert.equal(stopped.status, 200);
    assert.match(stopped.headers.get('set-cookie'), /^rc_impersonation=/);
  } finally {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
});
