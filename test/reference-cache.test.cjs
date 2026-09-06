const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cachedReferenceData,
  invalidateReferenceData,
  referenceCacheSnapshot,
} = require('../dist/reference-cache.js');

test.beforeEach(() => invalidateReferenceData());

test('reference cache coalesces loads and invalidates explicitly', async () => {
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loader = async () => {
    loads += 1;
    await gate;
    return [{ id: 1 }];
  };

  const pending = Array.from({ length: 12 }, () => cachedReferenceData('economy-catalog', loader));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  release();
  await Promise.all(pending);
  assert.deepEqual(await cachedReferenceData('economy-catalog', loader), [{ id: 1 }]);
  assert.equal(loads, 1);

  invalidateReferenceData('economy-catalog');
  await cachedReferenceData('economy-catalog', async () => {
    loads += 1;
    return [{ id: 2 }];
  });
  assert.equal(loads, 2);
  assert.equal(referenceCacheSnapshot().size, 1);
});

test('invalidation prevents an in-flight stale value from repopulating the cache', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stale = cachedReferenceData('economy-catalog', async () => {
    await gate;
    return 'stale';
  });
  await new Promise((resolve) => setImmediate(resolve));
  invalidateReferenceData('economy-catalog');
  const fresh = cachedReferenceData('economy-catalog', async () => 'fresh');
  release();
  assert.equal(await stale, 'stale');
  assert.equal(await fresh, 'fresh');
  assert.equal(await cachedReferenceData('economy-catalog', async () => 'wrong'), 'fresh');
});
