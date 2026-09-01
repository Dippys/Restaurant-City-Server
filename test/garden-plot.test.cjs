const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GARDEN_INGREDIENTS,
  gardenIngredientForSeed,
  gardenRarityWeightsForLevel,
  plantableIngredientIds,
  safeGardenIngredientId,
} = require('../dist/rpc/garden-plot.js');

const ALL_PLANTABLE_IDS = new Set([
  4000000, 4000003, 4000015, 4000038, 4000046, 4000051,
  4000053, 4000054, 4000055, 4000056, 4000057, 4000058,
]);

function randomSequence(...values) {
  let index = 0;
  return () => values[index++] ?? 0;
}

test('garden plot serialization accepts only ingredients with a plant movie clip', () => {
  const ids = plantableIngredientIds(`
    <database><group>
      <item id="4000000" name="Basil" plantClassName="BasilGrown"/>
      <item id="4000001" name="Bacon"/>
      <item id="not-a-number" plantClassName="BrokenGrown"/>
    </group></database>
  `);

  assert.deepEqual([...ids], [4000000]);
  assert.equal(safeGardenIngredientId(4000000, ids), 4000000);
  assert.equal(safeGardenIngredientId(4000001, ids), 0);
  assert.equal(safeGardenIngredientId(9999999, ids), 0);
});

test('garden catalog contains every and only shipped ingredient with a grown plant clip', () => {
  assert.deepEqual(new Set(GARDEN_INGREDIENTS.map((ingredient) => ingredient.id)), ALL_PLANTABLE_IDS);
});

test('garden rarity odds unlock progressively by player level', () => {
  assert.deepEqual(gardenRarityWeightsForLevel(1), [100, 0, 0, 0, 0]);
  assert.deepEqual(gardenRarityWeightsForLevel(12), [100, 0, 0, 0, 0]);
  assert.deepEqual(gardenRarityWeightsForLevel(13), [70, 30, 0, 0, 0]);
  assert.deepEqual(gardenRarityWeightsForLevel(22), [50, 35, 15, 0, 0]);
  assert.deepEqual(gardenRarityWeightsForLevel(28), [35, 30, 30, 5, 0]);
  assert.deepEqual(gardenRarityWeightsForLevel(32), [25, 25, 32, 15, 3]);
});

test('seedPlant rarity rolls honor level gates and exact tier boundaries', () => {
  assert.equal(gardenIngredientForSeed(1, randomSequence(0.999, 0.999), ALL_PLANTABLE_IDS), 4000058);
  assert.equal(gardenIngredientForSeed(13, randomSequence(0.6999, 0), ALL_PLANTABLE_IDS), 4000003);
  assert.equal(gardenIngredientForSeed(13, randomSequence(0.70, 0.999), ALL_PLANTABLE_IDS), 4000056);
  assert.equal(gardenIngredientForSeed(22, randomSequence(0.85, 0), ALL_PLANTABLE_IDS), 4000038);
  assert.equal(gardenIngredientForSeed(28, randomSequence(0.95, 0), ALL_PLANTABLE_IDS), 4000055);
  assert.equal(gardenIngredientForSeed(32, randomSequence(0.97, 0), ALL_PLANTABLE_IDS), 4000046);
});

test('seedPlant never selects a configured ingredient that the client cannot render', () => {
  const onlyBasilIsRenderable = new Set([4000000]);
  assert.equal(gardenIngredientForSeed(32, randomSequence(0.999, 0.999), onlyBasilIsRenderable), 4000000);
  assert.equal(gardenIngredientForSeed(32, randomSequence(0, 0), new Set()), 0);
});
