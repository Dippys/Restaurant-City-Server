const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
