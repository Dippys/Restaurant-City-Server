const test = require('node:test');
const assert = require('node:assert/strict');

const {
  gardenIngredientForSeed,
  plantableIngredientIds,
  safeGardenIngredientId,
} = require('../dist/rpc/garden-plot.js');

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

test('every seedPlant plot resolves to a renderable garden ingredient', () => {
  const ids = new Set([4000000, 4000003, 4000015]);

  assert.equal(gardenIngredientForSeed('0', ids), 4000000);
  assert.equal(gardenIngredientForSeed('1', ids), 4000003);
  assert.equal(gardenIngredientForSeed('2', ids), 4000015);
  assert.equal(gardenIngredientForSeed('3', ids), 4000000);
  assert.equal(gardenIngredientForSeed('1', new Set()), 0);
});
