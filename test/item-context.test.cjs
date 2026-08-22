const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterOwnedItemsByContext,
  ITEM_CONTEXT_CLOTHES,
  ITEM_CONTEXT_RESTAURANT_FACADE,
  ITEM_CONTEXT_RESTAURANT_INSIDE,
} = require('../dist/rpc/item-context.js');

const ownedItems = [
  { serverId: -1, globalItemId: 1010000 },
  { serverId: -2, globalItemId: 2010000 },
  { serverId: -3, globalItemId: 3010000 },
];

test('friend, random, and gourmet facade loads are disjoint from restaurant entry', () => {
  const facade = filterOwnedItemsByContext(ownedItems, ITEM_CONTEXT_RESTAURANT_FACADE);
  const restaurant = filterOwnedItemsByContext(ownedItems, ITEM_CONTEXT_RESTAURANT_INSIDE);

  assert.deepEqual(facade.map((item) => item.serverId), [-2]);
  assert.deepEqual(restaurant.map((item) => item.serverId), [-3]);
  const sequentialLoad = [...facade, ...restaurant];
  assert.equal(new Set(sequentialLoad.map((item) => item.serverId)).size, sequentialLoad.length);
});

test('combined item-context masks retain every requested placement type', () => {
  const allPlaced = filterOwnedItemsByContext(
    ownedItems,
    ITEM_CONTEXT_CLOTHES | ITEM_CONTEXT_RESTAURANT_FACADE | ITEM_CONTEXT_RESTAURANT_INSIDE,
  );
  assert.deepEqual(allPlaced.map((item) => item.serverId), [-1, -2, -3]);
});
