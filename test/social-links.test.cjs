const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-social-links-'));
const testDbName = `.social-links-test-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`], { cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8' });
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;

const { prisma } = require('../dist/db/client.js');
const { actOnLink, adminLifecycle, cancelPlayerLink, createAdminLink, createPlayerLink, decodeFoodKingLegacyUrl, publicLink, safeNextPath, sweepExpiredEscrow } = require('../dist/social-links/service.js');
const { renderSocialLanding } = require('../dist/social-links/landing.js');
const { createServer } = require('../dist/http-server.js');
const { loadConfig } = require('../dist/config.js');
const { hashSessionToken } = require('../dist/session.js');

let seq = 0;
async function seedAccount(name, role = 'USER') {
  seq += 1;
  const uid = String(810000000 + seq);
  const id = `account-${seq}`;
  await prisma.account.create({ data: { id, username: name, usernameKey: name.toLowerCase(), firstName: name, lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: uid, playfishUid: Number(uid), role } });
  await prisma.userProfile.create({ data: { id: `facebook:${uid}`, networkUid: uid, playfishUid: Number(uid), firstName: name, fullName: `${name} Chef`, restaurantName: `${name}'s Restaurant` } });
  return { id, username: name, networkUid: uid, playfishUid: Number(uid), role, csrfToken: 'csrf-token', sessionId: `session-${seq}` };
}

function encrypt(value) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from('d4ae3749fdd284924b4567bdbc7e3744', 'hex'), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]).toString('hex');
}

test.after(async () => { await prisma.$disconnect(); fs.rmSync(process.env.RC_DB_PATH, { force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); });

test('safe next accepts only same-origin relative paths', () => {
  assert.equal(safeNextPath('/s/abc?x=1'), '/s/abc?x=1');
  assert.equal(safeNextPath('//evil.example/x'), '/game');
  assert.equal(safeNextPath('/\\evil.example/x'), '/game');
  assert.equal(safeNextPath('https://evil.example/x'), '/game');
});

test('Food King legacy values decrypt and retain the shipped two-day expiry ceiling', async () => {
  const creator = await seedAccount('foodking');
  const now = new Date('2026-08-22T00:00:00Z');
  const expiry = Math.floor((now.getTime() + 2 * 86400000) / 1000);
  const legacyUrl = `https://legacy.invalid/foodking?pf_i_id=${encrypt(4000010)}&pf_ex=${encrypt(expiry)}&pf_uid=${encrypt(creator.networkUid)}&pf_fsig=ignored`;
  assert.deepEqual(decodeFoodKingLegacyUrl(legacyUrl), { itemId: 4000010, creatorUid: creator.networkUid, expiresAt: new Date(expiry * 1000) });
  const created = await createPlayerLink(creator, { kind: 'foodKingReward', legacyUrl }, now);
  const row = await prisma.socialLink.findUnique({ where: { id: created.id } });
  assert.equal(row.expiresAt.toISOString(), new Date(expiry * 1000).toISOString());
});

test('Food King rejects self-claim, duplicate claim, owned recipes, and expiry; item plus mail commit once', async () => {
  const creator = await seedAccount('kingmaker');
  const claimant = await seedAccount('kingclaim');
  const now = new Date('2026-08-22T02:00:00Z');
  const urlFor = (itemId) => `https://legacy.invalid/foodking?pf_i_id=${encrypt(itemId)}&pf_ex=${encrypt(Math.floor((now.getTime()+2*86400000)/1000))}&pf_uid=${encrypt(creator.networkUid)}`;
  const ingredientLink = await createPlayerLink(creator, { kind: 'foodKingReward', legacyUrl: urlFor(4000010) }, now);
  assert.equal((await actOnLink(ingredientLink.slug, creator, 'claim', 'self-key-1', now)).code, 'SELF_CLAIM');
  const first = await actOnLink(ingredientLink.slug, claimant, 'claim', 'claim-key-1', now);
  assert.equal(first.ok, true);
  const retry = await actOnLink(ingredientLink.slug, claimant, 'claim', 'claim-key-1', now);
  assert.equal(retry.ok, true);
  assert.equal((await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${claimant.networkUid}`, globalItemId: 4000010 } } })).number, 1);
  assert.equal(await prisma.mail.count({ where: { recipientNetworkUid: claimant.networkUid, type: 10 } }), 1);
  assert.equal((await actOnLink(ingredientLink.slug, await seedAccount('lateclaim'), 'claim', 'late-key-1', new Date(now.getTime()+2*86400000+1))).code, 'EXPIRED');

  const recipeLink = await createPlayerLink(creator, { kind: 'foodKingReward', legacyUrl: urlFor(5000019) }, now);
  const recipeOwner = await seedAccount('recipeowner');
  await prisma.inventoryItem.create({ data: { id: `facebook:${recipeOwner.networkUid}:inventory:5000019`, userProfileId: `facebook:${recipeOwner.networkUid}`, globalItemId: 5000019, number: 1 } });
  assert.equal((await actOnLink(recipeLink.slug, recipeOwner, 'claim', 'recipe-key-1', now)).code, 'ALREADY_OWNED');
});

test('ingredient request transfers one owned ingredient and idempotency prevents a second transfer', async () => {
  const requester = await seedAccount('requester'); const fulfiller = await seedAccount('fulfiller');
  await prisma.ingredientInventory.create({ data: { id: `facebook:${fulfiller.networkUid}:ingredient:4000003`, userProfileId: `facebook:${fulfiller.networkUid}`, globalItemId: 4000003, number: 2 } });
  const link = await createPlayerLink(requester, { kind: 'ingredientRequest', ingredientId: 4000003 });
  await prisma.socialLink.update({ where: { id: link.id }, data: { imagePath: '/assets/food-butter.png' } });
  const presentation = await publicLink(link.slug, null);
  assert.equal(presentation.imagePath, '/assets/ingredients/4000003.png');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', presentation.imagePath.slice(1))), true);
  assert.equal((await actOnLink(link.slug, fulfiller, 'fulfill', 'fulfill-1')).ok, true);
  assert.equal((await actOnLink(link.slug, fulfiller, 'fulfill', 'fulfill-1')).ok, true);
  assert.equal((await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${fulfiller.networkUid}`, globalItemId: 4000003 } } })).number, 1);
  assert.equal((await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${requester.networkUid}`, globalItemId: 4000003 } } })).number, 1);
});

test('gift and trade escrow hold, transfer, cancellation, and exact return', async () => {
  const owner = await seedAccount('escrowowner'); const recipient = await seedAccount('escrowrecipient');
  await prisma.ingredientInventory.createMany({ data: [
    { id: `facebook:${owner.networkUid}:ingredient:4000010`, userProfileId: `facebook:${owner.networkUid}`, globalItemId: 4000010, number: 3 },
    { id: `facebook:${recipient.networkUid}:ingredient:4000016`, userProfileId: `facebook:${recipient.networkUid}`, globalItemId: 4000016, number: 2 },
  ] });
  const cancelled = await createPlayerLink(owner, { kind: 'directGift', itemId: 4000010, category: 'ingredient', quantity: 2 });
  assert.equal((await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${owner.networkUid}`, globalItemId: 4000010 } } })).number, 1);
  await cancelPlayerLink(cancelled.slug, owner);
  assert.equal((await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${owner.networkUid}`, globalItemId: 4000010 } } })).number, 3);
  await assert.rejects(() => cancelPlayerLink(cancelled.slug, owner));

  const trade = await createPlayerLink(owner, { kind: 'ingredientTrade', offerItemId: 4000010, offerQuantity: 1, wantItemId: 4000016, wantQuantity: 2 });
  assert.equal((await actOnLink(trade.slug, recipient, 'accept', 'trade-key-1')).ok, true);
  const escrow = await prisma.socialLinkEscrow.findFirst({ where: { socialLinkId: trade.id } });
  assert.equal(escrow.state, 'TRANSFERRED');
  assert.equal((await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${owner.networkUid}`, globalItemId: 4000016 } } })).number, 2);
  assert.equal((await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${recipient.networkUid}`, globalItemId: 4000010 } } })).number, 1);
});

test('expired held escrow is returned exactly once by scheduled maintenance', async () => {
  const owner = await seedAccount('expiryowner');
  await prisma.ingredientInventory.create({ data: { id: `facebook:${owner.networkUid}:ingredient:4000010`, userProfileId: `facebook:${owner.networkUid}`, globalItemId: 4000010, number: 1 } });
  const now = new Date('2026-08-22T08:00:00Z');
  await createPlayerLink(owner, { kind: 'directGift', itemId: 4000010, quantity: 1, expiresAt: new Date(now.getTime() + 1000).toISOString() }, now);
  assert.equal(await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${owner.networkUid}`, globalItemId: 4000010 } } }), null);
  assert.equal(await sweepExpiredEscrow(new Date(now.getTime() + 1001)), 1);
  assert.equal(await sweepExpiredEscrow(new Date(now.getTime() + 2000)), 0);
  assert.equal((await prisma.ingredientInventory.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${owner.networkUid}`, globalItemId: 4000010 } } })).number, 1);
});

test('concurrent gift claims produce one winner and one durable transfer', async () => {
  const owner = await seedAccount('raceowner'); const first = await seedAccount('racefirst'); const second = await seedAccount('racesecond');
  await prisma.ingredientInventory.create({ data: { id: `facebook:${owner.networkUid}:ingredient:4000010`, userProfileId: `facebook:${owner.networkUid}`, globalItemId: 4000010, number: 1 } });
  const link = await createPlayerLink(owner, { kind: 'directGift', itemId: 4000010, quantity: 1 });
  const attempts = await Promise.allSettled([
    actOnLink(link.slug, first, 'claim', 'race-key-first'),
    actOnLink(link.slug, second, 'claim', 'race-key-second'),
  ]);
  const winners = attempts.filter((entry) => entry.status === 'fulfilled' && entry.value.ok);
  assert.equal(winners.length, 1);
  const counts = await prisma.ingredientInventory.findMany({ where: { userProfileId: { in: [`facebook:${first.networkUid}`, `facebook:${second.networkUid}`] }, globalItemId: 4000010 } });
  assert.equal(counts.reduce((sum, row) => sum + row.number, 0), 1);
  assert.equal((await prisma.socialLink.findUnique({ where: { id: link.id } })).successfulActionCount, 1);
  assert.equal((await prisma.socialLinkEscrow.findFirst({ where: { socialLinkId: link.id } })).state, 'TRANSFERRED');
});

test('failed trade acceptance rolls back the accepter and leaves escrow held', async () => {
  const owner = await seedAccount('rollbackowner'); const accepter = await seedAccount('rollbackaccept');
  await prisma.ingredientInventory.create({ data: { id: `facebook:${owner.networkUid}:ingredient:4000010`, userProfileId: `facebook:${owner.networkUid}`, globalItemId: 4000010, number: 1 } });
  const link = await createPlayerLink(owner, { kind: 'ingredientTrade', offerItemId: 4000010, offerQuantity: 1, wantItemId: 4000016, wantQuantity: 1 });
  assert.equal((await actOnLink(link.slug, accepter, 'accept', 'rollback-key-1')).code, 'INSUFFICIENT_INVENTORY');
  assert.equal((await prisma.socialLinkEscrow.findFirst({ where: { socialLinkId: link.id } })).state, 'HELD');
  assert.equal(await prisma.ingredientInventory.count({ where: { userProfileId: `facebook:${accepter.networkUid}` } }), 0);
});

test('employee snacks and discovery link templates are server-owned and actionable', async () => {
  const creator = await seedAccount('templateowner'); const viewer = await seedAccount('templateviewer');
  const snack = await createPlayerLink(creator, { kind: 'employeeSnack', itemId: 6000000 });
  assert.equal((await actOnLink(snack.slug, viewer, 'claim', 'snack-key-1')).ok, true);
  assert.equal((await prisma.inventoryItem.findUnique({ where: { userProfileId_globalItemId: { userProfileId: `facebook:${viewer.networkUid}`, globalItemId: 6000000 } } })).number, 1);
  for (const kind of ['referral','restaurantVisit','gardenHelp','restaurantRating','playerProfile','screenshot','achievement','leaderboard']) {
    const link = await createPlayerLink(creator, { kind, imageType: 0, source: 'level-up' });
    const state = await publicLink(link.slug, viewer);
    assert.equal(state.kind, kind); assert.equal(state.availability, 'available');
  }
});

test('friend invitation creates friendship without hiring and referral records a separate join', async () => {
  const inviter = await seedAccount('inviter'); const invitee = await seedAccount('invitee');
  const link = await createPlayerLink(inviter, { kind: 'friendInvite' });
  assert.equal((await actOnLink(link.slug, invitee, 'accept', 'friend-key-1')).ok, true);
  assert.equal(await prisma.friendship.count(), 1);
  assert.equal(await prisma.employee.count({ where: { OR: [{ userProfileId: `facebook:${inviter.networkUid}` }, { userProfileId: `facebook:${invitee.networkUid}` }] } }), 0);
  const referral = await createPlayerLink(inviter, { kind: 'referral' });
  const joined = await actOnLink(referral.slug, invitee, 'join', 'referral-key-1');
  assert.equal(joined.ok, true); assert.equal(joined.outcome, 'joined');
  assert.equal(await prisma.friendship.count(), 1);
});

test('admin campaign lifecycle, claim, metadata, repeated public reads, and audit export source stay consistent', async () => {
  const admin = await seedAccount('operator', 'ADMIN'); const player = await seedAccount('campaignuser');
  await assert.rejects(() => createAdminLink(player, { kind: 'promotion', reward: { category: 'coins', amount: 1 } }), /Administrator/);
  const created = await createAdminLink(admin, { kind: 'promotion', title: '<b>Safe reward</b>', description: 'Campaign reward', imagePath: '/assets/food-pizza.png', reward: { category: 'coins', amount: 25 }, totalActionLimit: 2, perAccountLimit: 1 });
  assert.equal((await publicLink(created.slug, null)).availability, 'paused');
  await adminLifecycle(admin, created.id, 'activate');
  const before = await prisma.socialLinkAction.count();
  const state1 = await publicLink(created.slug, null); const state2 = await publicLink(created.slug, null);
  assert.equal(await prisma.socialLinkAction.count(), before);
  const html = renderSocialLanding(state1, 'https://rc-reborn.uk');
  assert.match(html, /og:title/); assert.match(html, /og:image/); assert.doesNotMatch(html, /account-/);
  assert.equal(state2.availability, 'available');
  assert.equal((await actOnLink(created.slug, player, 'claim', 'campaign-key-1')).ok, true);
  assert.equal((await prisma.userProfile.findUnique({ where: { id: `facebook:${player.networkUid}` } })).credits, 50025);
  await adminLifecycle(admin, created.id, 'pause');
  assert.equal((await publicLink(created.slug, null)).availability, 'paused');
  await adminLifecycle(admin, created.id, 'resume');
  const duplicate = await adminLifecycle(admin, created.id, 'duplicate');
  assert.equal(duplicate.status, 'DRAFT'); assert.notEqual(duplicate.slug, created.slug);
  await adminLifecycle(admin, created.id, 'revoke');
  assert.equal((await publicLink(created.slug, null)).availability, 'revoked');
});

test('admin campaign eligibility is normalized and rechecked at claim time', async () => {
  const admin = await seedAccount('eligibilityadmin', 'ADMIN');
  const eligible = await seedAccount('EligibleChef');
  const excluded = await seedAccount('ExcludedChef');
  await prisma.userProfile.update({ where: { id: `facebook:${eligible.networkUid}` }, data: { userLevel: 12 } });
  await prisma.inventoryItem.create({ data: { id: `facebook:${eligible.networkUid}:inventory:6000000`, userProfileId: `facebook:${eligible.networkUid}`, globalItemId: 6000000, number: 1 } });
  const created = await createAdminLink(admin, {
    kind: 'specialDay', title: 'Eligible chefs', description: 'Policy test', reward: { category: 'coins', amount: 5 },
    eligibility: { minLevel: 10, maxLevel: 20, allowlistUsernames: ['ELIGIBLECHEF'], requireOwnedItemId: 6000000 },
  });
  await adminLifecycle(admin, created.id, 'activate');
  assert.equal((await actOnLink(created.slug, excluded, 'claim', 'eligibility-excluded')).code, 'NOT_ELIGIBLE');
  assert.equal((await actOnLink(created.slug, eligible, 'claim', 'eligibility-allowed')).ok, true);
  assert.equal((await prisma.userProfile.findUnique({ where: { id: `facebook:${eligible.networkUid}` } })).credits, 50005);
});

test('HTTP GET/HEAD are crawler-safe while actions require session, CSRF and same origin', async () => {
  const creator = await seedAccount('httpcreator'); const viewer = await seedAccount('httpviewer');
  const created = await createPlayerLink(creator, { kind: 'achievement', source: 'level-up' });
  const rawToken = crypto.randomBytes(32).toString('base64url');
  await prisma.session.create({ data: { id: 'http-session', tokenHash: hashSessionToken(rawToken), csrfToken: 'http-csrf', accountId: viewer.id, expiresAt: new Date(Date.now() + 60000) } });
  const config = { ...loadConfig(), port: 0, host: '127.0.0.1' };
  const { httpServer } = createServer(config);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port; const origin = `http://127.0.0.1:${port}`;
  try {
    for (const method of ['GET', 'GET', 'HEAD']) {
      const response = await fetch(`${origin}/s/${created.slug}`, { method }); assert.equal(response.status, 200);
    }
    const ingredientIcon = await fetch(`${origin}/assets/ingredients/4000015.png`);
    assert.equal(ingredientIcon.status, 200);
    assert.equal(ingredientIcon.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await ingredientIcon.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal((await fetch(`${origin}/assets/ingredients/not-an-id.png`)).status, 404);
    assert.equal((await fetch(`${origin}/assets/ingredients/4000015.svg`)).status, 404);
    assert.equal(await prisma.socialLinkAction.count({ where: { socialLinkId: created.id } }), 0);
    const cookie = `rc_session=${rawToken}`;
    const missing = await fetch(`${origin}/__api/social-links/${created.slug}/actions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin }, body: JSON.stringify({ action: 'view', idempotencyKey: 'http-key-1' }) });
    assert.equal(missing.status, 403);
    const foreign = await fetch(`${origin}/__api/social-links/${created.slug}/actions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example', 'x-csrf-token': 'http-csrf' }, body: JSON.stringify({ action: 'view', idempotencyKey: 'http-key-2' }) });
    assert.equal(foreign.status, 403);
    const originless = await fetch(`${origin}/__api/social-links/${created.slug}/actions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': 'http-csrf' }, body: JSON.stringify({ action: 'view', idempotencyKey: 'http-key-originless' }) });
    assert.equal(originless.status, 403);
    const success = await fetch(`${origin}/__api/social-links/${created.slug}/actions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin, 'x-csrf-token': 'http-csrf' }, body: JSON.stringify({ action: 'view', idempotencyKey: 'http-key-3' }) });
    assert.equal(success.status, 200);
  } finally { await new Promise((resolve) => httpServer.close(resolve)); }
});

test('Ruffle host maps existing in-game shares to a prepared browser modal without a generic page menu', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.html'), 'utf8');
  const gameWorld = fs.readFileSync(path.join(__dirname, '..', '..', 'decompiled', 'game', 'scripts', 'com', 'playfish', 'games', 'cooking', 'GameWorld.as'), 'utf8');
  for (const call of ['addStream', 'addFeedSystem', 'addInviteFriendsIFrame', 'addInviteStickersIFrame', 'addSendGiftIFrame']) assert.match(html, new RegExp(`window\\.${call}`));
  for (const control of ['Prepared in Restaurant City', 'Prepared link', 'Copy Link', 'Retry', 'Cancel', 'navigator.share', 'sendToActionScript', 'rcSocialPreview']) assert.match(html, new RegExp(control.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /kind: "foodKingReward", legacyUrl/);
  assert.match(html, /kind: "ingredientRequest", ingredientId/);
  assert.match(html, /if \(!window\.rcIsFullscreen\(\)\) return;/);
  assert.match(gameWorld, /getQualifiedClassName\(streamFeed\) == "com\.playfish\.coretech\.platform\.socialplatform::SocialFeed"/);
  assert.match(gameWorld, /new ExternalPage\("stream"\)\.show\(legacyStream\.toStream\(userInput\)\)/);
  assert.doesNotMatch(html, /id="socialButton"/);
  assert.doesNotMatch(html, /socialButton\.addEventListener/);
  assert.doesNotMatch(html, /prompt\(/);
});
