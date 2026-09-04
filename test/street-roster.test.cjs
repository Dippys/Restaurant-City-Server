const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectHireCandidateProfiles,
  selectGourmetStreetProfiles,
  selectRandomStreetProfiles,
  prioritizeInGameRoster,
} = require('../dist/rpc/street-roster.js');

const profiles = Array.from({ length: 15 }, (_, index) => ({
  networkUid: String(index + 1),
  playCount: 3,
  userLevel: index + 1,
  gourmetPoint: (index + 1) * 20_000,
}));

test('Random Street excludes owner and hired friends, caps at 20, and reshuffles', () => {
  const hired = new Set(['2', '4']);
  const first = selectRandomStreetProfiles(profiles, '1', hired, 50, () => 0);
  const second = selectRandomStreetProfiles(profiles, '1', hired, 50, (upper) => upper - 1);

  assert.equal(first.length, 12);
  assert.equal(second.length, 12);
  assert.ok(first.every((profile) => !hired.has(profile.networkUid) && profile.networkUid !== '1'));
  assert.ok(second.every((profile) => !hired.has(profile.networkUid) && profile.networkUid !== '1'));
  assert.notDeepEqual(first.map((profile) => profile.networkUid), second.map((profile) => profile.networkUid));
});

test('Hire candidates use a separate random non-hired pool', () => {
  const hired = new Set(['2', '4']);
  const largePool = Array.from({ length: 75 }, (_, index) => ({
    networkUid: String(index + 1),
    playCount: 1,
    userLevel: 1,
    gourmetPoint: 0,
  }));
  const candidates = selectHireCandidateProfiles(largePool, '1', hired, 100, () => 0);

  assert.equal(candidates.length, 20);
  assert.ok(candidates.every((profile) => !hired.has(profile.networkUid) && profile.networkUid !== '1'));
});

test('in-game roster prioritizes employers, then 48-hour activity, then everyone else', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const candidates = [
    { networkUid: 'inactive', employsActivePlayer: false, lastSeenAt: new Date('2026-09-01T00:00:00Z') },
    { networkUid: 'recent-old', employsActivePlayer: false, lastSeenAt: new Date('2026-09-04T00:01:00Z') },
    { networkUid: 'employer', employsActivePlayer: true, lastSeenAt: null },
    { networkUid: 'recent-new', employsActivePlayer: false, lastSeenAt: new Date('2026-09-05T11:00:00Z') },
  ];

  assert.deepEqual(
    prioritizeInGameRoster(candidates, 20, now).map((candidate) => candidate.networkUid),
    ['employer', 'recent-new', 'recent-old', 'inactive'],
  );
  assert.equal(prioritizeInGameRoster(Array.from({ length: 30 }, (_, index) => ({
    networkUid: String(index), employsActivePlayer: false, lastSeenAt: null,
  })), 100, now).length, 20);
});

// --- Gourmet Street (ADR-0037: scored ranking, no hard level/point gates) ---

// 30 placed interior decorations, a 60k-point balance, a 6-dish level-3 menu,
// 12 outdoor plants, and 12 votes averaging 4.2 — a strong restaurant.
function strongProfile(networkUid) {
  return {
    networkUid,
    playCount: 5,
    userLevel: 18,
    gourmetPoint: 60_000,
    nbVote: 12,
    totalMark: Math.round(12 * 4.2),
    ownedItems: [
      ...Array.from({ length: 30 }, (_, index) => ({ globalItemId: 3030010 + index })),
      ...Array.from({ length: 12 }, (_, index) => ({ globalItemId: 3120000 + index })),
      // Fixed invisible trio + an award must not count as furniture.
      { globalItemId: 3100000 },
      { globalItemId: 3200000 },
      { globalItemId: 3300000 },
      { globalItemId: 3400000 },
    ],
    inventoryItems: [
      { globalItemId: 5000008, number: 3, isSelected: true },
      { globalItemId: 5100003, number: 3, isSelected: true },
      { globalItemId: 5200000, number: 3, isSelected: true },
      { globalItemId: 5000001, number: 3, isSelected: true },
      { globalItemId: 5000002, number: 3, isSelected: true },
      { globalItemId: 5000003, number: 3, isSelected: true },
      { globalItemId: 5000999, number: 99, isSelected: false }, // not on the menu
      { globalItemId: 4000005, number: 7, isSelected: false }, // ingredient, not a recipe
    ],
  };
}

// A fresh starter restaurant: 18 interior placements, 3 starter level-1 dishes,
// nothing else. It still qualifies (score > 0) so Gourmet Street fills up.
function starterProfile(networkUid) {
  return {
    networkUid,
    playCount: 1,
    userLevel: 1,
    gourmetPoint: 0,
    nbVote: 0,
    totalMark: 0,
    ownedItems: Array.from({ length: 18 }, (_, index) => ({ globalItemId: 3030010 + index })),
    inventoryItems: [
      { globalItemId: 5000008, number: 1, isSelected: true },
      { globalItemId: 5100003, number: 1, isSelected: true },
      { globalItemId: 5200000, number: 1, isSelected: true },
    ],
  };
}

test('Gourmet Street ranks by score: a strong restaurant outranks a starter one', () => {
  const pool = [starterProfile('2'), strongProfile('3'), starterProfile('4')];
  const selected = selectGourmetStreetProfiles(pool, '1', 50);

  assert.deepEqual(selected.map((profile) => profile.networkUid), ['3', '2', '4']);
});

test('Gourmet Street caps at 20, excludes the owner, and drops score-0 profiles', () => {
  const empty = {
    networkUid: '99',
    playCount: 1,
    userLevel: 1,
    gourmetPoint: 0,
    nbVote: 0,
    totalMark: 0,
    ownedItems: [],
    inventoryItems: [],
  };
  const pool = [
    empty,
    ...Array.from({ length: 25 }, (_, index) => strongProfile(String(100 + index))),
  ];
  const selected = selectGourmetStreetProfiles(pool, '100', 50);

  assert.equal(selected.length, 20);
  assert.ok(selected.every((profile) => profile.networkUid !== '100'));
  assert.ok(selected.every((profile) => profile.networkUid !== '99'));
});

test('Gourmet Street ordering is deterministic (gourmet points, then uid, break ties)', () => {
  const identical = (uid) => ({
    networkUid: uid,
    playCount: 1,
    userLevel: 10,
    gourmetPoint: 30_000,
    nbVote: 0,
    totalMark: 0,
    ownedItems: [{ globalItemId: 3030010 }, { globalItemId: 3030011 }],
    inventoryItems: [],
  });
  const pool = [identical('b'), identical('a'), identical('c')];
  const selected = selectGourmetStreetProfiles(pool, 'z', 50);

  assert.deepEqual(selected.map((profile) => profile.networkUid), ['a', 'b', 'c']);
});
