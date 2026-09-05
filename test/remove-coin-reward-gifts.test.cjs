const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const projectRoot = path.resolve(__dirname, '..');
const cleanupScript = path.join(projectRoot, 'scripts', 'remove-coin-reward-gifts.cjs');

function createFixture(databasePath) {
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE UserProfile (id TEXT PRIMARY KEY, credits INTEGER);
    CREATE TABLE Mail (
      id INTEGER PRIMARY KEY,
      recipientProfileId TEXT,
      globalItemIdsJson TEXT,
      read INTEGER,
      type INTEGER
    );
    CREATE TABLE InventoryItem (id TEXT PRIMARY KEY, userProfileId TEXT, globalItemId INTEGER, number INTEGER);
    CREATE TABLE OwnedItem (id TEXT PRIMARY KEY, userProfileId TEXT, globalItemId INTEGER);
    CREATE TABLE IngredientInventory (id TEXT PRIMARY KEY, userProfileId TEXT, globalItemId INTEGER, number INTEGER);
    CREATE TABLE GardenPlot (id TEXT PRIMARY KEY, userProfileId TEXT, ingredientId INTEGER);

    INSERT INTO UserProfile VALUES ('profile-1', 25000), ('profile-2', 5000);
    INSERT INTO Mail VALUES
      (1, 'profile-1', '[6020019]', 1, 4),
      (2, 'profile-1', '[6020019]', 0, 4),
      (3, 'profile-2', '[3040001]', 1, 4),
      (4, 'profile-2', '[6020019]', 1, 1);
    INSERT INTO InventoryItem VALUES
      ('bad-reward', 'profile-1', 6020019, 2),
      ('good-chair', 'profile-2', 3040001, 1);
  `);
  db.close();
}

function runCleanup(databasePath, ...args) {
  return spawnSync(process.execPath, [cleanupScript, '--database', databasePath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

test('coin reward cleanup is read-only by default and removes only matching type-4 gifts', (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-coin-gift-cleanup-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const databasePath = path.join(fixtureDir, 'fixture.db');
  createFixture(databasePath);

  const report = runCleanup(databasePath);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Matching gift mails: 2 across 1 profiles \(1 opened\)/);
  assert.match(report.stdout, /Read-only: nothing changed/);

  const apply = runCleanup(databasePath, '--apply');
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Removed 2 mails, 1 stored item rows/);
  assert.match(apply.stdout, /coins were not changed/);

  const db = new Database(databasePath, { readonly: true });
  assert.deepEqual(db.prepare('SELECT id FROM Mail ORDER BY id').all(), [{ id: 3 }, { id: 4 }]);
  assert.deepEqual(db.prepare('SELECT globalItemId FROM InventoryItem').all(), [{ globalItemId: 3040001 }]);
  assert.equal(db.prepare("SELECT credits FROM UserProfile WHERE id = 'profile-1'").get().credits, 25000);
  db.close();
  assert.equal(fs.readdirSync(fixtureDir).filter((name) => name.startsWith('fixture.db.bak-')).length, 1);
});

test('optional opened-mail revocation debits once per opened reward and clamps at zero', (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-coin-gift-debit-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const databasePath = path.join(fixtureDir, 'fixture.db');
  createFixture(databasePath);

  const apply = runCleanup(databasePath, '--apply', '--revoke-opened-coins');
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Debited 10000 coins across 1 profiles/);

  const db = new Database(databasePath, { readonly: true });
  assert.equal(db.prepare("SELECT credits FROM UserProfile WHERE id = 'profile-1'").get().credits, 15000);
  assert.equal(db.prepare("SELECT credits FROM UserProfile WHERE id = 'profile-2'").get().credits, 5000);
  db.close();
});
