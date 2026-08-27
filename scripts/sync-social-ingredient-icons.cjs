const fs = require('node:fs');
const path = require('node:path');

const serverRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(serverRoot, '..');
const clientRoot = path.join(workspaceRoot, 'client-html5');
const ingredientsPath = path.join(clientRoot, 'public', 'assets', 'generated', 'data', 'ingredients.json');
const workDir = path.join(clientRoot, 'tools', '.work', 'ingredient_asset');
const extractPath = path.join(workDir, 'extract.json');
const outputDir = path.join(serverRoot, 'public', 'assets', 'ingredients');

const ingredientData = JSON.parse(fs.readFileSync(ingredientsPath, 'utf8'));
const extract = JSON.parse(fs.readFileSync(extractPath, 'utf8'));
const ingredients = ingredientData.groups.find((group) => group.name === 'Ingredient')?.items ?? [];
const frames = new Map(extract.symbols.flatMap((symbol) => symbol.frames.map((frame) => [frame.key, frame.file])));

fs.mkdirSync(outputDir, { recursive: true });
const written = new Set();

for (const ingredient of ingredients) {
  const key = `ingredient_asset/${String(ingredient.className).toLowerCase()}/idle`;
  const frameFile = frames.get(key);
  if (!frameFile) throw new Error(`Missing extracted ingredient frame: ${key}`);
  const source = path.join(workDir, ...frameFile.split(/[\\/]/));
  const bytes = fs.readFileSync(source);
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error(`Not a PNG: ${source}`);
  const filename = `${ingredient.id}.png`;
  fs.writeFileSync(path.join(outputDir, filename), bytes);
  written.add(filename);
}

for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
  if (entry.isFile() && /^\d+\.png$/.test(entry.name) && !written.has(entry.name)) {
    fs.unlinkSync(path.join(outputDir, entry.name));
  }
}

console.log(`Synced ${written.size} original ingredient icons to ${outputDir}`);
