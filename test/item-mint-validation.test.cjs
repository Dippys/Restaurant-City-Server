const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Regression coverage for the item-mint holes:
//  - sendMail (RPC 19) type-4 gifts previously minted ANY item id, including
//    invisible/unavailable rows like the 3 Million Fans Statue (3500093);
//  - buyMysteryBox (RPC 32) minted whatever numeric id the token embedded;
//  - the save-audit purchase path priced invisible rows (statue cost="1")
//    instead of rejecting them, so a crafted save could buy the statue.

const testDbName = `.item-mint-validation-${process.pid}.db`;
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
const { sendMail, buyMysteryBox } = require('../dist/db/rpc-store.js');
const { savePlayerProfile } = require('../dist/db/profile-store.js');
const { coinPriceForItemId } = require('../dist/db/item-catalog.js');

const INVISIBLE_STATUE = 3500093; // 3 Million Fans Statue — invisible=true
const VISIBLE_CHAIR = 3040001;    // Classic Chair — normal shop item

let seq = 0;
async function seedProfile(name) {
  seq += 1;
  const networkUid = String(970000000 + seq);
  const account = { username: name, networkUid, playfishUid: Number(networkUid), sessionId: `session-${seq}` };
  await prisma.userProfile.create({
    data: {
      id: `facebook:${networkUid}`,
      networkUid,
      playfishUid: Number(networkUid),
      firstName: name,
      fullName: `${name} Chef`,
      restaurantName: `${name}'s Restaurant`,
      demandPoint: 120,
    },
  });
  return account;
}

async function inventoryItem(account, globalItemId) {
  return prisma.inventoryItem.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: `facebook:${account.networkUid}`, globalItemId } },
  });
}

test('coinPriceForItemId refuses invisible/non-shop rows', () => {
  assert.equal(coinPriceForItemId(INVISIBLE_STATUE), null);
  assert.equal(coinPriceForItemId(VISIBLE_CHAIR), 200);
});

test('a type-4 gift mail of an invisible item is rejected and mints nothing', async () => {
  const sender = await seedProfile('giftsender');
  const recipient = await seedProfile('giftrecipient');
  const target = { network: 2, networkUid: recipient.networkUid, playfishUid: recipient.playfishUid };

  // Crafted gift of the 3 Million Fans Statue must be refused.
  const status = await sendMail(sender, { recipient: target, globalItemIds: [INVISIBLE_STATUE], itemId: 0, message: '', type: 4 });
  assert.equal(status, 4); // STATUS_INVALID_TOKEN
  assert.equal(await inventoryItem(recipient, INVISIBLE_STATUE), null);
  assert.equal(await prisma.mail.count({ where: { recipientProfileId: `facebook:${recipient.networkUid}` } }), 0);

  // An unknown id is refused too.
  assert.equal(await sendMail(sender, { recipient: target, globalItemIds: [999999999], itemId: 0, message: '', type: 4 }), 4);

  // A real, visible shop item still gifts fine.
  const ok = await sendMail(sender, { recipient: target, globalItemIds: [VISIBLE_CHAIR], itemId: 0, message: 'A chair for you', type: 4 });
  assert.equal(ok, 0); // STATUS_OK
  const granted = await inventoryItem(recipient, VISIBLE_CHAIR);
  assert.equal(granted?.number, 1);
});

test('buyMysteryBox refuses non-catalog or invisible tokens and mints nothing', async () => {
  const player = await seedProfile('boxbuyer');
  assert.equal(await buyMysteryBox(player, 'statue', ['3500093']), 4);
  assert.equal(await inventoryItem(player, INVISIBLE_STATUE), null);
  assert.equal(await buyMysteryBox(player, 'junk', ['not-an-item']), 4);
  assert.equal(await inventoryItem(player, 3040001), null); // no fallback mint either
});

test('a suspicious save-audit purchase preserves gameplay and alerts moderation', async () => {
  const player = await seedProfile('savebuyer');
  const profile = await prisma.userProfile.findUnique({ where: { id: `facebook:${player.networkUid}` } });
  const saved = {
    id: { network: 2, networkUid: player.networkUid, playfishUid: player.playfishUid },
    restaurantName: profile.restaurantName,
    gourmetPoint: profile.gourmetPoint,
    trashPoint: profile.trashPoint,
    demandPoint: profile.demandPoint,
    musicPlay: profile.musicPlay,
    isInStreet: false,
    awards: null,
    userLevel: profile.userLevel,
    activeFloorIndex: 0,
  };
  const audit = {
    saveVersion: 1,
    timeOnClient: 1,
    creditDelta: 0,
    newCredits: null,
    upsertOwnedItems: [],
    removeOwnedItemIds: [],
    inventoryChanges: [{ globalItemId: INVISIBLE_STATUE, delta: 1 }],
    bulkInventoryMoves: [],
    ingredientChanges: [],
    lockIngredientChanges: [],
    gardenChanges: [],
    floorChanges: [],
    employeeChanges: [],
    openMailIds: [],
    deleteMailIds: [],
    visitedFriends: [],
    purchases: [{ kind: 'inventory', itemId: INVISIBLE_STATUE, qty: 1, token: 'SVL.plZzqrs7dHEmsbzxsq', unresolved: false }],
  };
  const result = await savePlayerProfile(saved, audit);
  assert.equal(result.status, 'saved');
  assert.equal((await inventoryItem(player, INVISIBLE_STATUE))?.number, 1);
  assert.equal((await prisma.anomalyFinding.findUnique({ where: { fingerprint: `${player.networkUid}:SAVE_PRICING_WARNING` } }))?.status, 'OPEN');
});
