const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.discord-oauth-test-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`], {
  cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8',
});
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;
process.env.RC_DISCORD_CLIENT_ID = '123456789012345678';
process.env.RC_DISCORD_CLIENT_SECRET = 'test-client-secret';
delete process.env.RC_DISCORD_BOT_TOKEN;
delete process.env.RC_PUBLIC_ORIGIN;

const nativeFetch = global.fetch;
const { prisma } = require('../dist/db/client.js');
const { loadConfig } = require('../dist/config.js');
const { createServer } = require('../dist/http-server.js');
const { createDiscordLoginTicket, safeReturnPath } = require('../dist/discord-oauth.js');
const { registerAccount } = require('../dist/db/auth-store.js');

test.after(async () => {
  global.fetch = nativeFetch;
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

test('Discord return paths reject cross-origin and malformed destinations', () => {
  assert.equal(safeReturnPath('/account?tab=discord'), '/account?tab=discord');
  assert.equal(safeReturnPath('//evil.example/path'), '/game');
  assert.equal(safeReturnPath('https://evil.example/path'), '/game');
  assert.equal(safeReturnPath('/bad\\path'), '/game');
});

test('first Discord login creates a linked Discord-only profile and session', async () => {
  global.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://discord.com/api/v10/oauth2/token') {
      assert.equal(init.method, 'POST');
      assert.match(String(init.body), /grant_type=authorization_code/);
      return new Response(JSON.stringify({ access_token: 'user-token', token_type: 'Bearer', scope: 'identify email guilds.join' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://discord.com/api/v10/users/@me') {
      assert.equal(init.headers.Authorization, 'Bearer user-token');
      return new Response(JSON.stringify({ id: '987654321098765432', username: 'discordchef', global_name: 'Discord Chef', email: 'chef@example.test', avatar: 'avatarhash' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return nativeFetch(input, init);
  };

  const { httpServer } = createServer({ ...loadConfig(), port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    const begin = await nativeFetch(`${origin}/auth/discord?next=%2Faccount`, { redirect: 'manual' });
    assert.equal(begin.status, 303);
    const authorization = new URL(begin.headers.get('location'));
    assert.equal(authorization.hostname, 'discord.com');
    assert.equal(authorization.searchParams.get('scope'), 'identify email guilds.join');
    const stateCookie = begin.headers.get('set-cookie').split(';')[0];
    const callback = await nativeFetch(`${origin}/auth/discord/callback?code=oauth-code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`, {
      headers: { cookie: stateCookie }, redirect: 'manual',
    });
    assert.equal(callback.status, 303);
    assert.match(callback.headers.get('location'), /^\/discord\/complete/);
    const setCookies = callback.headers.getSetCookie();
    const ticketCookie = setCookies.find((value) => value.startsWith('rc_discord_ticket=')).split(';')[0];

    const complete = await nativeFetch(`${origin}/__api/discord/complete`, {
      method: 'POST', headers: { cookie: ticketCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', username: 'discordchef', firstName: 'Discord', lastName: 'Chef', next: '/account' }),
    });
    assert.equal(complete.status, 201, await complete.text());
    const completeCookies = complete.headers.getSetCookie();
    const sessionCookie = completeCookies.find((value) => value.startsWith('rc_session=')).split(';')[0];
    const session = await nativeFetch(`${origin}/__api/session`, { headers: { cookie: sessionCookie } }).then((response) => response.json());
    assert.equal(session.loggedIn, true);
    assert.equal(session.account.username, 'discordchef');
    assert.equal(session.account.pinEnabled, false);
    assert.equal(session.discord.linked, true);
    assert.equal(session.discord.showLinkPrompt, false);
    assert.equal(await prisma.userProfile.count({ where: { networkUid: session.account.networkUid } }), 1);
    assert.equal((await prisma.discordIdentity.findUnique({ where: { discordUserId: '987654321098765432' } })).email, 'chef@example.test');
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('first Discord login can verify and link an existing PIN profile', async () => {
  const existing = await registerAccount({ username: 'existingchef', firstName: 'Existing', lastName: 'Chef', pin: '246810' }, '127.0.0.1', 'test');
  const ticket = (await createDiscordLoginTicket({
    id: '876543210987654321', username: 'existingdiscord', globalName: 'Existing Discord',
    email: 'existing@example.test', avatarHash: '',
  }, false)).split(';')[0];
  const { httpServer } = createServer({ ...loadConfig(), port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    const wrong = await nativeFetch(`${origin}/__api/discord/complete`, {
      method: 'POST', headers: { cookie: ticket, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'existing', username: 'existingchef', pin: '111111', next: '/game' }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(await prisma.discordLoginTicket.count({ where: { discordUserId: '876543210987654321' } }), 1);

    const complete = await nativeFetch(`${origin}/__api/discord/complete`, {
      method: 'POST', headers: { cookie: ticket, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'existing', username: 'existingchef', pin: '246810', next: '/game' }),
    });
    assert.equal(complete.status, 200, await complete.text());
    const sessionCookie = complete.headers.getSetCookie().find((value) => value.startsWith('rc_session=')).split(';')[0];
    const session = await nativeFetch(`${origin}/__api/session`, { headers: { cookie: sessionCookie } }).then((response) => response.json());
    assert.equal(session.account.id, existing.account.id);
    assert.equal(session.account.pinEnabled, true);
    assert.equal(session.discord.username, 'existingdiscord');
    assert.equal(await prisma.discordLoginTicket.count({ where: { discordUserId: '876543210987654321' } }), 0);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
