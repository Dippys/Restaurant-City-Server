const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDbName = `.moderation-test-${process.pid}.db`;
const testDbPath = path.join(__dirname, '..', testDbName);
fs.writeFileSync(testDbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH;
const push = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${testDbName}`], { cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8' });
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = testDbPath;

const { prisma } = require('../dist/db/client.js');
const { savePlayerProfile } = require('../dist/db/profile-store.js');
const { evaluateProfile, levelForGourmet, unlocksForLevel } = require('../dist/moderation/rules.js');
const { moderationPlayerDetail, recordLoginActivity, recordRpcActivity, resetAllFindings, resolveProfileSignals, scanPlayer, setPlayerBan, terminatePlayerSessions, rollbackProfile, resetProfileToStarter } = require('../dist/moderation/service.js');
const { sendPendingAnomalyDigest, validateModerationWebhookUrl } = require('../dist/moderation/discord.js');
const { claimGameInstance, activeGameInstance } = require('../dist/game-instances.js');
const { touchOnline, listOnlineUsers } = require('../dist/live-events.js');

const admin = { id: 'admin-id', username: 'moderator', networkUid: '999001', playfishUid: 999001, role: 'ADMIN' };

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbPath, { force: true });
});

async function seed(uid, username, overrides = {}) {
  const accountId = `account-${uid}`;
  await prisma.account.create({ data: { id: accountId, username, usernameKey: username.toLowerCase(), firstName: username, lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: uid, playfishUid: Number(uid), ...overrides.account } });
  await prisma.userProfile.create({ data: {
    id: `facebook:${uid}`, networkUid: uid, playfishUid: Number(uid), firstName: username, fullName: `${username} Chef`, restaurantName: `${username}'s Restaurant`,
    credits: 0, cashBalance: 250, playCount: 1, userLevel: 1, gourmetPoint: 0, demandPoint: 120, musicPlay: 0,
    floors: { create: [0, 1].map((floorIndex) => ({ id: `facebook:${uid}:floor:${floorIndex}`, floorIndex, tilesJson: JSON.stringify(Array(800).fill(0)) })) },
    ...overrides.profile,
  } });
  return { id: accountId, username, networkUid: uid, playfishUid: Number(uid), sessionId: `session-${uid}`, role: 'USER' };
}

function audit(version, time, overrides = {}) {
  return { saveVersion: version, timeOnClient: time, creditDelta: 0, newCredits: null, upsertOwnedItems: [], removeOwnedItemIds: [], inventoryChanges: [], bulkInventoryMoves: [], ingredientChanges: [], lockIngredientChanges: [], gardenChanges: [], floorChanges: [], employeeChanges: [], openMailIds: [], deleteMailIds: [], visitedFriends: [], actionCount: 0, unknownActionCount: 0, actionTypeCounts: {}, ...overrides };
}

function profile(account, overrides = {}) {
  return { id: { network: 2, networkUid: account.networkUid, playfishUid: account.playfishUid }, restaurantName: `${account.username}'s Restaurant`, gourmetPoint: 0, trashPoint: 0, demandPoint: 120, musicPlay: 0, isInStreet: false, awards: null, userLevel: 1, activeFloorIndex: 0, ...overrides };
}

async function session(account, rpcToken = '') {
  await prisma.session.create({ data: { id: account.sessionId, tokenHash: `token-${account.networkUid}-${Date.now()}`, csrfToken: 'csrf', accountId: account.id, expiresAt: new Date('2035-01-01T00:00:00Z'), rpcSessionToken: rpcToken } });
}

test('AS3 progression rules identify exact contradictions and keep context separate', () => {
  assert.equal(levelForGourmet(49), 0);
  assert.equal(levelForGourmet(50), 1);
  assert.equal(levelForGourmet(500000), 32);
  assert.deepEqual(unlocksForLevel(10), { employees: 5, gardenPlots: 1, layouts: 2, numDishes: 2 });
  const findings = evaluateProfile({
    networkUid: 'rule-test', credits: 2_000_000, cashBalance: 250, userLevel: 4, gourmetPoint: 50,
    activeFloorIndex: 2, createdAt: new Date(), ownedItems: [], inventoryItems: [{ globalItemId: 123, number: -1, isSelected: false }],
    ingredients: [], gardenPlots: [{ ingredientId: 4000000 }], employees: [{}, {}, {}, {}], cashTransactions: [],
  }, { totalActiveSeconds: 5400, loginCount: 1, requestCount: 1, saveCount: 1 }, null, new Date());
  const ids = new Set(findings.map((finding) => finding.ruleId));
  for (const expected of ['LEVEL_GOURMET_MISMATCH', 'EMPLOYEE_UNLOCK_EXCEEDED', 'GARDEN_UNLOCK_EXCEEDED', 'LAYOUT_UNLOCK_EXCEEDED', 'NEGATIVE_ITEM_QUANTITY', 'UNKNOWN_ITEM_IDENTITIES', 'COINS_VS_MEASURED_TIME']) assert.equal(ids.has(expected), true, expected);
  const ahead = findings.find((finding) => finding.ruleId === 'LEVEL_GOURMET_MISMATCH');
  assert.equal(ahead.severity, 'CRITICAL');
  assert.equal(ahead.evidence.direction, 'LEVEL_AHEAD');

  const behind = evaluateProfile({
    networkUid: 'level-catchup', credits: 0, cashBalance: 250, userLevel: 4, gourmetPoint: 14150,
    activeFloorIndex: 0, createdAt: new Date(), ownedItems: [], inventoryItems: [], ingredients: [],
    gardenPlots: [], employees: [], cashTransactions: [],
  }, null, null, new Date()).find((finding) => finding.ruleId === 'LEVEL_GOURMET_MISMATCH');
  assert.equal(behind.severity, 'HIGH');
  assert.equal(behind.evidence.direction, 'LEVEL_BEHIND');
});

test('first scan creates one baseline rollback point and later scans do not duplicate it', async () => {
  const account = await seed('81007', 'BaselineChef');
  await scanPlayer(account.networkUid);
  await scanPlayer(account.networkUid);
  const snapshots = await prisma.profileSnapshot.findMany({ where: { networkUid: account.networkUid } });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].reason, 'INITIAL_BASELINE');
});

test('accepted saves create immutable facts and rollback restores state while revoking sessions', async () => {
  const account = await seed('81001', 'RollbackChef');
  await session(account, 'rpc-rollback');
  await recordLoginActivity(account);
  const result = await savePlayerProfile(profile(account, { gourmetPoint: 500000, userLevel: 1 }), audit(1, 300, { creditDelta: 2_000_000, actionCount: 1, actionTypeCounts: { 2: 1 } }), { authSessionId: account.sessionId, rpcSessionToken: 'rpc-rollback', payloadDigest: 'save-one' });
  assert.deepEqual(result, { status: 'saved', savedVersion: 1 });
  const snapshots = await prisma.profileSnapshot.findMany({ where: { networkUid: account.networkUid } });
  const facts = await prisma.profileSaveFact.findMany({ where: { networkUid: account.networkUid } });
  assert.equal(snapshots.length, 1);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].gourmetDelta, 500000);
  assert.equal(facts[0].creditDelta, 2000000);
  assert.equal((await moderationPlayerDetail(account.networkUid)).findings.some((finding) => finding.ruleId === 'LEVEL_GOURMET_MISMATCH'), true);

  await rollbackProfile(account.networkUid, snapshots[0].id, admin, 'Restore the last clean save');
  const restored = await prisma.userProfile.findUniqueOrThrow({ where: { networkUid: account.networkUid } });
  assert.equal(restored.gourmetPoint, 0);
  assert.equal(restored.credits, 0);
  assert.equal(restored.userLevel, 1);
  assert.equal(await prisma.session.count({ where: { accountId: account.id } }), 0);
  assert.equal(await prisma.profileSnapshot.count({ where: { networkUid: account.networkUid } }), 2);
  assert.equal(await prisma.moderationAction.count({ where: { targetNetworkUid: account.networkUid, actionType: 'ROLLBACK' } }), 1);
});

test('reset-to-starter is recoverable and restores shipped starter collections', async () => {
  const account = await seed('81002', 'ResetChef', { profile: { credits: 999999, userLevel: 20, gourmetPoint: 86000 } });
  await resetProfileToStarter(account.networkUid, admin, 'Confirmed impossible profile');
  const detail = await prisma.userProfile.findUniqueOrThrow({ where: { networkUid: account.networkUid }, include: { ownedItems: true, inventoryItems: true, ingredients: true, floors: true } });
  assert.equal(detail.userLevel, 1);
  assert.equal(detail.gourmetPoint, 0);
  assert.equal(detail.credits, 0);
  assert.equal(detail.ownedItems.length, 29);
  assert.equal(detail.inventoryItems.filter((item) => item.isSelected).length, 3);
  assert.equal(detail.ingredients.length, 7);
  assert.equal(detail.floors.length, 2);
  assert.equal(await prisma.profileSnapshot.count({ where: { networkUid: account.networkUid, reason: 'ADMIN_BEFORE_RESET' } }), 1);
});

test('terminate and ban revoke persistent plus live state; unban is explicit', async () => {
  const account = await seed('81003', 'KickChef');
  await session(account);
  claimGameInstance(account.networkUid, 'instance-1234');
  touchOnline(account);
  assert.equal(activeGameInstance(account.networkUid), 'instance-1234');
  assert.equal(listOnlineUsers().some((user) => user.networkUid === account.networkUid), true);
  assert.deepEqual(await terminatePlayerSessions(account.networkUid, admin, 'Stop current suspicious activity'), { revokedSessions: 1 });
  assert.equal(activeGameInstance(account.networkUid), null);
  assert.equal(listOnlineUsers().some((user) => user.networkUid === account.networkUid), false);

  await session(account);
  const banned = await setPlayerBan(account.networkUid, true, admin, 'Confirmed manipulated progression');
  assert.equal(banned.banned, true);
  assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).disabled, true);
  assert.equal(await prisma.session.count({ where: { accountId: account.id } }), 0);
  await setPlayerBan(account.networkUid, false, admin, 'Appeal accepted after review');
  assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).disabled, false);
});

test('measured activity accumulates bounded RPC gaps and counts logins/saves separately', async () => {
  const account = await seed('81004', 'ActivityChef');
  await recordLoginActivity(account);
  await prisma.playerActivity.update({ where: { accountId: account.id }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
  await recordRpcActivity(account);
  const activity = await prisma.playerActivity.findUniqueOrThrow({ where: { accountId: account.id } });
  assert.equal(activity.loginCount, 1);
  assert.equal(activity.rpcCount, 1);
  assert.equal(activity.totalActiveSeconds, 120);
});

test('Discord digest is secret-safe, idempotent per evidence revision, and retries pending revisions', async () => {
  const account = await seed('81005', 'DiscordChef', { profile: { userLevel: 30, gourmetPoint: 50 } });
  await scanPlayer(account.networkUid);
  assert.throws(() => validateModerationWebhookUrl('http://example.com/nope'), /Discord HTTPS webhook/);
  const webhook = 'https://discord.com/api/webhooks/123456789/secret_token';
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => { calls.push({ url: String(url), body: String(init.body) }); return new Response('{}', { status: 200 }); };
  try {
    const first = await sendPendingAnomalyDigest(webhook);
    assert.equal(first.sent > 0, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.includes('secret_token'), false);
    assert.equal(JSON.parse(calls[0].body).content.startsWith('@here '), true);
    assert.deepEqual(await sendPendingAnomalyDigest(webhook), { sent: 0 });
    assert.equal(calls.length, 1);
    await prisma.userProfile.update({ where: { networkUid: account.networkUid }, data: { gourmetPoint: 70 } });
    await scanPlayer(account.networkUid);
    assert.equal((await sendPendingAnomalyDigest(webhook)).sent > 0, true);
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fixed profiles resolve open findings without erasing review history', async () => {
  const account = await seed('81006', 'ResolveChef', { profile: { userLevel: 30, gourmetPoint: 50 } });
  await scanPlayer(account.networkUid);
  const open = await prisma.anomalyFinding.findUniqueOrThrow({ where: { fingerprint: `${account.networkUid}:LEVEL_GOURMET_MISMATCH` } });
  assert.equal(open.status, 'OPEN');
  await prisma.userProfile.update({ where: { networkUid: account.networkUid }, data: { userLevel: 1 } });
  const summary = await scanPlayer(account.networkUid);
  assert.equal(summary.findingsResolved >= 1, true);
  assert.equal((await prisma.anomalyFinding.findUniqueOrThrow({ where: { id: open.id } })).status, 'RESOLVED');
});

test('reset all findings wipes the queue and a re-scan recreates fresh findings', async () => {
  const account = await seed('81009', 'ResetQueueChef', { profile: { userLevel: 30, gourmetPoint: 50 } });
  await scanPlayer(account.networkUid);
  const before = await prisma.anomalyFinding.count({ where: { networkUid: account.networkUid } });
  assert.equal(before > 0, true);
  const totalBefore = await prisma.anomalyFinding.count();
  const reset = await resetAllFindings();
  assert.equal(reset, totalBefore);
  assert.equal(await prisma.anomalyFinding.count(), 0);
  await scanPlayer(account.networkUid);
  assert.equal(await prisma.anomalyFinding.count({ where: { networkUid: account.networkUid } }), before);
});

test('resolve signals fires over-cap staff, deselects over-cap dishes, catches level up, and audits', async () => {
  const account = await seed('81010', 'SignalChef', { profile: { userLevel: 4, gourmetPoint: 5000 } });
  const profileId = `facebook:${account.networkUid}`;
  // 6 employees at level 4/5 (cap 4); 3 selected dishes (course 50 x2, course 51 x1, cap 1/course);
  // gourmet 5000 -> displayed 500 -> level 5.
  await prisma.employee.createMany({ data: [1, 2, 3, 4, 5, 6].map((i) => ({
    id: `${profileId}:emp:${i}`, userProfileId: profileId, networkUid: `emp-${i}`,
    network: 2, playfishUid: i, createdAt: new Date(`2026-08-2${i}T00:00:00Z`),
  })) });
  await prisma.inventoryItem.createMany({ data: [5000000, 5000008, 5100003].map((gid, i) => ({
    id: `${profileId}:inv:${gid}`, userProfileId: profileId, globalItemId: gid, number: 1, isSelected: true,
    createdAt: new Date(`2026-08-2${i + 1}T00:00:00Z`),
  })) });

  const result = await resolveProfileSignals(account.networkUid, { id: 'admin-id', username: 'moderator' });
  assert.equal(result.employeesFired, 2); // 6 - level-5 cap 4
  assert.equal(result.dishesDeselected, 1); // course 50 had 2, cap 1
  assert.equal(result.levelBumped, 1); // level 4 -> 5
  assert.equal(result.changed, true);

  const profile = await prisma.userProfile.findUniqueOrThrow({ where: { networkUid: account.networkUid } });
  assert.equal(profile.userLevel, 5);
  assert.equal(await prisma.employee.count({ where: { userProfileId: profileId } }), 4);
  const selected = await prisma.inventoryItem.findMany({ where: { userProfileId: profileId, isSelected: true } });
  assert.equal(selected.map((item) => item.globalItemId).sort((a, b) => a - b).join(','), '5000000,5100003');
  assert.equal(await prisma.moderationAction.count({ where: { targetNetworkUid: account.networkUid, actionType: 'RESOLVE_SIGNALS' } }), 1);
  assert.equal((await prisma.profileSnapshot.count({ where: { networkUid: account.networkUid, reason: 'SIGNAL_FIX' } })), 1);

  await scanPlayer(account.networkUid);
  const open = await prisma.anomalyFinding.findMany({ where: { networkUid: account.networkUid, status: 'OPEN' } });
  assert.equal(open.length, 0);
});

test('save-fact client deltas are stored in seconds and reset across RPC sessions', async () => {
  const account = await seed('81008', 'TimeDeltaChef');
  await prisma.session.create({ data: { id: 'sess-a', tokenHash: 't-a', csrfToken: 'c', accountId: account.id, expiresAt: new Date('2035-01-01T00:00:00Z'), rpcSessionToken: 'rpc-time-a' } });
  const fenceA = { authSessionId: 'sess-a', rpcSessionToken: 'rpc-time-a', payloadDigest: 'a' };
  await savePlayerProfile(profile(account), audit(1, 60000), fenceA); // t+60s
  await savePlayerProfile(profile(account), audit(2, 120300), { ...fenceA, payloadDigest: 'b' }); // +60.3s

  // new RPC session (new fence token, saveVersion restarts at 1, clock resets)
  await prisma.session.create({ data: { id: 'sess-b', tokenHash: 't-b', csrfToken: 'c', accountId: account.id, expiresAt: new Date('2035-01-01T00:00:00Z'), rpcSessionToken: 'rpc-time-b' } });
  await savePlayerProfile(profile(account), audit(1, 30000), { authSessionId: 'sess-b', rpcSessionToken: 'rpc-time-b', payloadDigest: 'c' });

  const facts = await prisma.profileSaveFact.findMany({ where: { networkUid: account.networkUid }, orderBy: { createdAt: 'asc' } });
  assert.equal(facts.length, 3);
  // 60,300 ms -> 60 s, not 60,300 "seconds"
  assert.equal(facts[1].clientDeltaSeconds, 60);
  // a reload (new session, smaller clientTime) is not a reversed clock
  assert.equal(facts[2].clientDeltaSeconds, 0);
});

test('clock rules use real seconds and the measured-time rules need a measured hour', () => {
  const base = {
    networkUid: 'clock-rule', credits: 0, cashBalance: 250, userLevel: 5, gourmetPoint: 5000,
    activeFloorIndex: 0, createdAt: new Date(), ownedItems: [], inventoryItems: [], ingredients: [],
    gardenPlots: [], employees: [], cashTransactions: [],
  };
  const fact = (clientDeltaSeconds, serverDeltaSeconds) => ({
    creditDelta: 0, gourmetDelta: 0, clientDeltaSeconds, serverDeltaSeconds, actionCount: 1, unknownActionCount: 0, createdAt: new Date(),
  });
  // a normal 60 s autosave is not "accelerated"
  assert.equal(evaluateProfile(base, null, fact(60, 60), new Date()).some((f) => f.ruleId === 'CLIENT_TIME_ACCELERATED'), false);
  // a genuine 60,000 s claim in 60 s is
  assert.equal(evaluateProfile(base, null, fact(60000, 60), new Date()).some((f) => f.ruleId === 'CLIENT_TIME_ACCELERATED'), true);
  // ADR-0042: a real same-session reversal flags; sub-15 s timer noise does not
  assert.equal(evaluateProfile(base, null, fact(-20, 60), new Date()).some((f) => f.ruleId === 'CLIENT_TIME_REVERSED'), true);
  assert.equal(evaluateProfile(base, null, fact(-5, 60), new Date()).some((f) => f.ruleId === 'CLIENT_TIME_REVERSED'), false);
  // lifetime gourmet vs a fresh activity tracker (<1 measured hour) is not flagged
  const fresh = evaluateProfile({ ...base, gourmetPoint: 900000 }, { totalActiveSeconds: 1800, loginCount: 1, requestCount: 1, saveCount: 1 }, null, new Date());
  assert.equal(fresh.some((f) => f.ruleId === 'GOURMET_VS_MEASURED_TIME'), false);
  const measured = evaluateProfile({ ...base, gourmetPoint: 900000 }, { totalActiveSeconds: 5400, loginCount: 1, requestCount: 1, saveCount: 1 }, null, new Date());
  assert.equal(measured.some((f) => f.ruleId === 'GOURMET_VS_MEASURED_TIME'), true);
});
