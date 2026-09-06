const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('normal server startup does not run legacy database-wide repairs', () => {
  const server = fs.readFileSync(path.join(root, 'src', 'server.ts'), 'utf8');
  for (const symbol of ['repairLegacyCashIngredientPurchases', 'repairMisclassifiedRestaurantEntitlements', 'repairLegacyAdminCoinMailRewards']) {
    assert.equal(server.includes(symbol), false, symbol);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['repair:legacy-data-v1'], /run-legacy-repairs-v1\.cjs/);
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'run-legacy-repairs-v1.cjs')), true);
});

test('systemd launches the built server without forcing SQLite or mutating schema', () => {
  const service = fs.readFileSync(path.join(root, '..', 'deploy', 'rc-reborn.service'), 'utf8');
  assert.match(service, /ExecStart=\/usr\/bin\/npm run start:built/);
  assert.doesNotMatch(service, /Environment=RC_DB_PATH/);
  assert.doesNotMatch(service, /ExecStart=.*npm start\s*$/m);
  const guide = fs.readFileSync(path.join(root, '..', 'deploy', 'README.md'), 'utf8');
  assert.match(guide, /DATABASE_URL=postgresql:/);
  assert.match(guide, /npm run repair:legacy-data-v1/);
  assert.match(guide, /health\/live/);
  assert.match(guide, /health\/ready/);
});
