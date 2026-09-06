const test = require('node:test');
const assert = require('node:assert/strict');

const { KeyedWorkLimiter } = require('../dist/database-work.js');

test('profile work serializes each player while respecting the global limit', async () => {
  const limiter = new KeyedWorkLimiter(2);
  let totalActive = 0;
  let maximumTotal = 0;
  const perKeyActive = new Map();
  let sameKeyOverlap = false;

  const work = (key) => limiter.run(key, async () => {
    totalActive += 1;
    maximumTotal = Math.max(maximumTotal, totalActive);
    const keyActive = (perKeyActive.get(key) ?? 0) + 1;
    perKeyActive.set(key, keyActive);
    if (keyActive > 1) sameKeyOverlap = true;
    await new Promise((resolve) => setImmediate(resolve));
    perKeyActive.set(key, keyActive - 1);
    totalActive -= 1;
    return key;
  });

  assert.deepEqual(await Promise.all([work('a'), work('a'), work('b'), work('c')]), ['a', 'a', 'b', 'c']);
  assert.equal(maximumTotal, 2);
  assert.equal(sameKeyOverlap, false);
  assert.deepEqual(limiter.snapshot(), { active: 0, waiting: 0, serializedKeys: 0, maxConcurrency: 2 });
});

test('failed work releases both the player queue and global slot', async () => {
  const limiter = new KeyedWorkLimiter(1);
  await assert.rejects(limiter.run('a', async () => { throw new Error('temporary'); }), /temporary/);
  assert.equal(await limiter.run('a', async () => 'recovered'), 'recovered');
  assert.equal(limiter.snapshot().active, 0);
});
