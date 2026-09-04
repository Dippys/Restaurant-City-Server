const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLeaderboardEntries, TtlSingleFlightCache } = require('../dist/db/leaderboard.js');

function profile(networkUid, overrides = {}) {
  return {
    networkUid,
    username: `Chef${networkUid}`,
    restaurantName: `Restaurant ${networkUid}`,
    userLevel: 1,
    gourmetPoint: 0,
    nbVote: 0,
    totalMark: 0,
    bookmarkCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

test('gourmet leaderboard ranks by points with stable username tie breaking', () => {
  const entries = buildLeaderboardEntries([
    profile('1', { username: 'Zulu', gourmetPoint: 500 }),
    profile('2', { username: 'Alpha', gourmetPoint: 900 }),
    profile('3', { username: 'Bravo', gourmetPoint: 500 }),
  ], new Map(), 'gourmet');
  assert.deepEqual(entries.map((entry) => entry.username), ['Alpha', 'Bravo', 'Zulu']);
  assert.deepEqual(entries.map((entry) => entry.rank), [1, 2, 3]);
});

test('rated leaderboard requires five votes and tempers small samples toward the community mean', () => {
  const entries = buildLeaderboardEntries([
    profile('1', { username: 'TooFew', nbVote: 4, totalMark: 20 }),
    profile('2', { username: 'SmallFive', nbVote: 5, totalMark: 25 }),
    profile('3', { username: 'Trusted', nbVote: 100, totalMark: 480 }),
  ], new Map(), 'rated');
  assert.deepEqual(entries.map((entry) => entry.username), ['SmallFive', 'Trusted']);
  assert.equal(entries[0].rating, 5);
  assert.ok(entries[0].score < entries[0].rating);
});

test('rising leaderboard uses net period gains and omits non-positive totals', () => {
  const entries = buildLeaderboardEntries(
    [profile('1'), profile('2'), profile('3')],
    new Map([['1', 200], ['2', -50], ['3', 75]]),
    'rising',
  );
  assert.deepEqual(entries.map((entry) => [entry.networkUid, entry.gourmetGain]), [['1', 200], ['3', 75]]);
});

test('rank movement compares a refreshed snapshot with the previous ranking', () => {
  const entries = buildLeaderboardEntries(
    [profile('1', { gourmetPoint: 300 }), profile('2', { gourmetPoint: 200 })],
    new Map(),
    'gourmet',
    new Map([['1', 2], ['2', 1]]),
  );
  assert.equal(entries[0].movement, 1);
  assert.equal(entries[1].movement, -1);
});

test('TTL cache reuses values and coalesces concurrent misses', async () => {
  const cache = new TtlSingleFlightCache();
  let loads = 0;
  let release;
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => { release = resolve; });
  };
  const first = cache.get('board', 60_000, loader, 1);
  const second = cache.get('board', 60_000, loader, 1);
  assert.equal(loads, 1);
  release({ rows: 3 });
  assert.equal((await first).status, 'MISS');
  assert.equal((await second).status, 'COALESCED');
  const third = await cache.get('board', 60_000, async () => ({ rows: 9 }));
  assert.equal(third.status, 'HIT');
  assert.deepEqual(third.value, { rows: 3 });
});
