const test = require('node:test');
const assert = require('node:assert/strict');

const {
  coinBundleForToken,
  ingredientCashCost,
  ownedItemCashCost,
} = require('../dist/db/cash-catalog.js');

test('owned cash items use the XML cash price and bind the token to the item id', () => {
  assert.equal(ownedItemCashCost('vzQQjMQ7qyY6pB1QbGzMyW', 3110004), 5);
  assert.equal(ownedItemCashCost('vzQQjMQ7qyY6pB1QbGzMyW', 3040001), null);
  assert.equal(ownedItemCashCost('not-a-real-token', 3110004), null);
});

test('ingredient cash purchases sum each requested XML price', () => {
  assert.equal(ingredientCashCost(['jn7oj0vkTbuJkKA5QjzGda']), 4);
  assert.equal(ingredientCashCost(['jn7oj0vkTbuJkKA5QjzGda', 'dn5yovNc6QRAjcTpMYvSva']), 10);
  assert.equal(ingredientCashCost([]), null);
  assert.equal(ingredientCashCost(['vzQQjMQ7qyY6pB1QbGzMyW']), null);
});

test('coin conversion uses the XML PF cost and coin payout', () => {
  assert.deepEqual(coinBundleForToken('jbcPCtwNvvrgkU7YFsCqQG'), { cashCost: 2, coinPayout: 1000 });
  assert.deepEqual(coinBundleForToken('NEYkpvNGnTZhf5vqRz.94a'), { cashCost: 10, coinPayout: 5000 });
  assert.equal(coinBundleForToken('not-a-real-token'), null);
});
