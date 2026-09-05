'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dbName = `.ingredient-reward-test-${process.pid}.db`;
const dbPath = path.join(__dirname, '..', dbName);
fs.writeFileSync(dbPath, '');
const pushEnv = { ...process.env };
delete pushEnv.RC_DB_PATH;
delete pushEnv.DATABASE_URL;
const push = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'),
  'db', 'push', '--url', `file:./${dbName}`,
], { cwd: path.join(__dirname, '..'), env: pushEnv, encoding: 'utf8' });
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = dbPath;

const { prisma } = require('../dist/db/client.js');
const { firstVisitFriend, replyQuiz } = require('../dist/db/rpc-store.js');
const { INGREDIENTS } = require('../dist/db/ingredient-data.js');
const { repairMissingIngredientRewards } = require('../dist/db/ingredient-reward-repair.js');
const { readOwnerProfile } = require('../dist/db/profile-store.js');

const player = { username: 'RewardPlayer', networkUid: '88001', playfishUid: 88001 };
const friend = { username: 'RewardFriend', networkUid: '88002', playfishUid: 88002 };
const otherFriend = { username: 'OtherFriend', networkUid: '88003', playfishUid: 88003 };

async function seed(identity) {
  await prisma.account.create({ data: {
    id: `account-${identity.networkUid}`, username: identity.username,
    usernameKey: identity.username.toLowerCase(), firstName: identity.username,
    lastName: 'Chef', pinHash: 'x', pinSalt: 'x', networkUid: identity.networkUid,
    playfishUid: identity.playfishUid,
  } });
  await prisma.userProfile.create({ data: {
    id: `facebook:${identity.networkUid}`, networkUid: identity.networkUid,
    playfishUid: identity.playfishUid, firstName: identity.username,
    fullName: `${identity.username} Chef`, restaurantName: `${identity.username}'s Restaurant`,
  } });
}

test.before(async () => {
  await seed(player);
  await seed(friend);
  await seed(otherFriend);
  await readOwnerProfile(player);
});

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(dbPath, { force: true });
});

test('first-visit reward is durable and a repeated RPC cannot grant it twice', async () => {
  const before = new Map((await prisma.ingredientInventory.findMany({ where: { userProfileId: `facebook:${player.networkUid}` } }))
    .map((row) => [row.globalItemId, row.number]));
  const first = await firstVisitFriend(player, { network: 2, networkUid: friend.networkUid, playfishUid: friend.playfishUid });
  assert.ok(first.gift.globalItemId > 0);
  const row = await prisma.ingredientInventory.findUniqueOrThrow({
    where: { userProfileId_globalItemId: { userProfileId: `facebook:${player.networkUid}`, globalItemId: first.gift.globalItemId } },
  });
  assert.equal(row.number, (before.get(first.gift.globalItemId) || 0) + 1);
  assert.equal(row.isLocked, true);

  const repeated = await firstVisitFriend(player, { network: 2, networkUid: friend.networkUid, playfishUid: friend.playfishUid });
  assert.equal(repeated.gift.globalItemId, 0);
  assert.equal((await prisma.ingredientInventory.findUniqueOrThrow({
    where: { userProfileId_globalItemId: { userProfileId: `facebook:${player.networkUid}`, globalItemId: first.gift.globalItemId } },
  })).number, row.number);
});

test('historical visit and quiz rewards preview and backfill exactly once', async () => {
  const eligible = INGREDIENTS.filter((ingredient) => !ingredient.noQuiz && !ingredient.noFirstTimeVisit);
  const visitReward = eligible[1];
  const quizReward = eligible[2];
  assert.ok(visitReward && quizReward);
  const profileId = `facebook:${player.networkUid}`;
  await prisma.friendVisit.create({ data: {
    id: `${profileId}:visit:${otherFriend.networkUid}`,
    userProfileId: profileId,
    friendNetworkUid: otherFriend.networkUid,
    friendPlayfishUid: otherFriend.playfishUid,
    firstVisitedAt: 1,
    lastVisitedAt: 1,
    giftIngredientId: visitReward.id,
  } });
  const mail = await prisma.mail.create({ data: {
    senderProfileId: `facebook:${friend.networkUid}`,
    recipientProfileId: profileId,
    senderNetworkUid: friend.networkUid,
    recipientNetworkUid: player.networkUid,
    senderPlayfishUid: friend.playfishUid,
    recipientPlayfishUid: player.playfishUid,
    sendDate: 1,
    type: 2,
    deleted: true,
  } });
  await prisma.gameEvent.create({ data: {
    userProfileId: profileId,
    eventType: 25,
    eventText: JSON.stringify({ quizId: mail.id, answer: quizReward.hash, correct: true }),
    createdAtUnix: 1,
  } });

  const preview = await repairMissingIngredientRewards(false);
  assert.equal(preview.missingFirstVisitRewards, 1);
  assert.equal(preview.missingQuizRewards, 1);
  assert.equal(preview.rewardsGranted, 0);
  const applied = await repairMissingIngredientRewards(true);
  assert.equal(applied.rewardsGranted, 2);
  assert.equal((await repairMissingIngredientRewards(false)).missingFirstVisitRewards, 0);
  assert.equal((await repairMissingIngredientRewards(false)).missingQuizRewards, 0);
});

test('correct quiz reward persists once and replaying the consumed mail grants nothing', async () => {
  const reward = INGREDIENTS.find((ingredient) => !ingredient.noQuiz);
  assert.ok(reward);
  const mail = await prisma.mail.create({ data: {
    senderProfileId: `facebook:${friend.networkUid}`,
    recipientProfileId: `facebook:${player.networkUid}`,
    senderNetworkUid: friend.networkUid,
    recipientNetworkUid: player.networkUid,
    senderPlayfishUid: friend.playfishUid,
    recipientPlayfishUid: player.playfishUid,
    sendDate: Math.floor(Date.now() / 1000), type: 2,
  } });

  await replyQuiz(player, mail.id, reward.hash, true);
  const key = { userProfileId_globalItemId: { userProfileId: `facebook:${player.networkUid}`, globalItemId: reward.id } };
  assert.equal((await prisma.ingredientInventory.findUniqueOrThrow({ where: key })).number, 1);
  assert.equal((await prisma.mail.findUniqueOrThrow({ where: { id: mail.id } })).deleted, true);

  await replyQuiz(player, mail.id, reward.hash, true);
  assert.equal((await prisma.ingredientInventory.findUniqueOrThrow({ where: key })).number, 1);
});
