const fs = require('node:fs');
const path = require('node:path');
const { dailyIngredientCatalog } = require('../dist/daily-ingredients/catalog.js');
const { renderDailyIngredientsImage } = require('../dist/daily-ingredients/image.js');

const serverRoot = path.resolve(__dirname, '..');
const output = path.join(serverRoot, 'test', '.tmp', 'daily-ingredients-preview.png');
fs.mkdirSync(path.dirname(output), { recursive: true });

renderDailyIngredientsImage(dailyIngredientCatalog().slice(0, 3), serverRoot)
  .then((png) => {
    fs.writeFileSync(output, png);
    console.log(output);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
