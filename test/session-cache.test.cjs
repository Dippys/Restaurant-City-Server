const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cachedSessionAccount,
  invalidateAllCachedSessions,
  sessionCacheSnapshot,
} = require('../dist/session-cache.js');

test.beforeEach(() => invalidateAllCachedSessions());

test('session cache coalesces concurrent misses and serves later hits', async () => {
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const account = { id: 'cached-account', username: 'chef', networkUid: '71', playfishUid: 71 };
  const before = sessionCacheSnapshot();
  const loader = async () => {
    loads += 1;
    await gate;
    return { account, ttlMs: 60_000 };
  };

  const requests = Array.from({ length: 20 }, () => cachedSessionAccount('same-token', loader));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  release();
  assert.deepEqual(await Promise.all(requests), Array.from({ length: 20 }, () => account));

  assert.equal(await cachedSessionAccount('same-token', loader), account);
  assert.equal(loads, 1);
  const after = sessionCacheSnapshot();
  assert.equal(after.misses - before.misses, 1);
  assert.equal(after.coalesced - before.coalesced, 19);
  assert.equal(after.hits - before.hits, 1);
});

test('session cache invalidation prevents an in-flight stale result from being cached', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const account = { id: 'stale-account', username: 'chef', networkUid: '72', playfishUid: 72 };
  const stale = cachedSessionAccount('stale-token', async () => {
    await gate;
    return { account };
  });
  await new Promise((resolve) => setImmediate(resolve));
  invalidateAllCachedSessions();
  release();
  assert.equal(await stale, account);

  let freshLoads = 0;
  const fresh = await cachedSessionAccount('stale-token', async () => {
    freshLoads += 1;
    return { account: null };
  });
  assert.equal(fresh, null);
  assert.equal(freshLoads, 1, 'the stale in-flight value must not repopulate the cache');
});
