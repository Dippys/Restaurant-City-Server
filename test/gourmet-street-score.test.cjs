const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GOURMET_STREET_WEIGHT_DISHES,
  GOURMET_STREET_WEIGHT_FURNITURE,
  GOURMET_STREET_WEIGHT_GOURMET,
  GOURMET_STREET_WEIGHT_OUTDOOR,
  GOURMET_STREET_WEIGHT_VOTES,
  gourmetStreetScore,
  gourmetStreetVoteScore,
} = require('../dist/rpc/street-roster.js');
const { outdoorItemIds } = require('../dist/db/item-catalog.js');

function profile(overrides = {}) {
  return {
    networkUid: '1',
    playCount: 1,
    userLevel: 1,
    gourmetPoint: 0,
    nbVote: 0,
    totalMark: 0,
    ownedItems: [],
    inventoryItems: [],
    ...overrides,
  };
}

const notOutdoor = () => false;
const isOutdoor = (id) => id >= 3120000 && id <= 3120021;

test('weights sum to 1 so the score stays in 0..1', () => {
  const total = (
    GOURMET_STREET_WEIGHT_FURNITURE +
    GOURMET_STREET_WEIGHT_GOURMET +
    GOURMET_STREET_WEIGHT_DISHES +
    GOURMET_STREET_WEIGHT_OUTDOOR +
    GOURMET_STREET_WEIGHT_VOTES
  );
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('votes: a single 5-star vote cannot match 10 votes at 3.5 stars', () => {
  const onePerfect = gourmetStreetVoteScore(1, 5);
  const tenGood = gourmetStreetVoteScore(10, 35);
  assert.ok(onePerfect < tenGood, `expected ${onePerfect} < ${tenGood}`);
  assert.ok(tenGood > 0.5, '10×3.5★ should be a strong votes signal');
  assert.ok(onePerfect < 0.25, '1×5★ should stay a weak votes signal');
});

test('votes: zero votes or an empty rating mark score zero', () => {
  assert.equal(gourmetStreetVoteScore(0, 0), 0);
  assert.equal(gourmetStreetVoteScore(0, 100), 0);
  assert.equal(gourmetStreetVoteScore(10, 0), 0);
});

test('votes: higher averages and more votes both raise the signal', () => {
  assert.ok(gourmetStreetVoteScore(10, 40) > gourmetStreetVoteScore(10, 35));
  assert.ok(gourmetStreetVoteScore(20, 80) > gourmetStreetVoteScore(5, 20));
});

test('outdoor items count as outdoor decoration, not as furniture', () => {
  const p = profile({
    ownedItems: [
      { globalItemId: 3030010 }, // table
      { globalItemId: 3120000 }, // outdoor plant
    ],
  });
  const furnitureOnly = gourmetStreetScore(p, notOutdoor);
  const withOutdoor = gourmetStreetScore(p, isOutdoor);

  assert.ok(furnitureOnly > 0, 'an interior table should contribute furniture');
  assert.ok(withOutdoor > furnitureOnly, 'recognizing the plant as outdoor must raise the score');
});

test('only selected recipe inventory items count as dish levels', () => {
  const base = profile();
  const onMenu = gourmetStreetScore({
    ...base,
    inventoryItems: [{ globalItemId: 5000008, number: 7, isSelected: true }],
  }, notOutdoor);
  const offMenu = gourmetStreetScore({
    ...base,
    inventoryItems: [{ globalItemId: 5000008, number: 7, isSelected: false }],
  }, notOutdoor);
  const ingredient = gourmetStreetScore({
    ...base,
    inventoryItems: [{ globalItemId: 4000005, number: 7, isSelected: true }],
  }, notOutdoor);

  assert.ok(onMenu > offMenu, 'an unselected recipe must not count');
  assert.equal(offMenu, ingredient, 'ingredients must not count as dish levels');
});

test('building facade and ingredient placements never count as furniture', () => {
  const p = profile({
    ownedItems: [
      { globalItemId: 2060000 }, // building body (2xxxxxx)
      { globalItemId: 4000005 }, // ingredient (4xxxxxx)
      { globalItemId: 3400000 }, // invisible award
      { globalItemId: 3100000 }, // fixed menu holder
      { globalItemId: 3030010 }, // real furniture
    ],
  });
  const p2 = profile({
    ownedItems: [{ globalItemId: 3030010 }],
  });
  assert.equal(gourmetStreetScore(p, notOutdoor), gourmetStreetScore(p2, notOutdoor));
});

test('gourmet points scale logarithmically: doubling points does not double the signal', () => {
  const hundredK = gourmetStreetScore(profile({ gourmetPoint: 100_000 }), notOutdoor);
  const twoHundredK = gourmetStreetScore(profile({ gourmetPoint: 200_000 }), notOutdoor);
  assert.ok(hundredK > 0 && twoHundredK > hundredK);
  assert.ok(twoHundredK - hundredK < 0.25 * hundredK, 'log scale compresses the tail');
});

test('the shipped restaurant.xml outdoor group drives the default predicate', () => {
  const outdoor = outdoorItemIds();
  assert.ok(outdoor.has(3120000), 'Green Bush is in the Outdoor Only group');
  assert.ok(outdoor.has(3120021), 'Heart Tree is in the Outdoor Only group');
  assert.ok(!outdoor.has(3030010), 'White Cloth Table is interior');
  assert.ok(!outdoor.has(3100000), 'Menu Holder is interior');
});

test('a fresh starter restaurant still scores above zero', () => {
  const starter = profile({
    ownedItems: Array.from({ length: 18 }, (_, index) => ({ globalItemId: 3030010 + index })),
    inventoryItems: [
      { globalItemId: 5000008, number: 1, isSelected: true },
      { globalItemId: 5100003, number: 1, isSelected: true },
      { globalItemId: 5200000, number: 1, isSelected: true },
    ],
  });
  assert.ok(gourmetStreetScore(starter, notOutdoor) > 0);
});
