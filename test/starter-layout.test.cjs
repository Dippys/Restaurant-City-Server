const test = require('node:test');
const assert = require('node:assert/strict');

const { repairProfileStateInTransaction } = require('../dist/db/profile-store.js');

const emptyFloor = JSON.stringify(Array.from({ length: 20 * 40 }, () => 0));

test('existing customized layouts never regain missing starter furniture during repair', async () => {
  let ownedItemCreates = 0;
  const tx = {
    ownedItem: {
      create: async () => {
        ownedItemCreates += 1;
      },
    },
    restaurantFloor: {
      create: async () => assert.fail('valid existing floors must not be recreated'),
      update: async () => assert.fail('valid existing floors must not be replaced'),
    },
    gardenPlot: {
      create: async () => assert.fail('level-one profiles have no unlocked garden plots'),
    },
    inventoryItem: {
      create: async () => assert.fail('an existing menu must not be backfilled'),
    },
    ingredientInventory: {
      create: async () => assert.fail('existing profile repair must not reach ingredient backfill'),
    },
    userProfile: {
      update: async () => assert.fail('valid existing profile scalars must not be changed'),
    },
  };

  const customizedProfile = {
    userLevel: 1,
    demandPoint: 120,
    // The player kept one custom placement and deliberately removed every
    // starter placement. Missing starter IDs are valid saved state.
    ownedItems: [{ serverId: 77, globalItemId: 3110004 }],
    inventoryItems: [{ globalItemId: 5000008, number: 1 }],
    ingredients: [],
    gardenPlots: [],
    floors: [
      { floorIndex: 0, tilesJson: emptyFloor },
      { floorIndex: 1, tilesJson: emptyFloor },
    ],
  };

  const repaired = await repairProfileStateInTransaction(
    tx,
    'decorator',
    'profile:decorator',
    true,
    customizedProfile,
  );

  assert.equal(repaired, false);
  assert.equal(ownedItemCreates, 0);
});
