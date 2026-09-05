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
    CREATE TABLE Account (networkUid TEXT, role TEXT);
    CREATE TABLE UserProfile (id TEXT PRIMARY KEY, credits INTEGER, cashBalance INTEGER, demandPoint INTEGER);
    CREATE TABLE Mail (
      id INTEGER PRIMARY KEY,
      senderNetworkUid TEXT,
      recipientProfileId TEXT,
      globalItemIdsJson TEXT,
      message TEXT,
      read INTEGER,
      type INTEGER
    );
    CREATE TABLE InventoryItem (id TEXT PRIMARY KEY, userProfileId TEXT, globalItemId INTEGER, number INTEGER);
    CREATE TABLE OwnedItem (id TEXT PRIMARY KEY, userProfileId TEXT, globalItemId INTEGER);
    CREATE TABLE IngredientInventory (id TEXT PRIMARY KEY, userProfileId TEXT, globalItemId INTEGER, number INTEGER);
    CREATE TABLE GardenPlot (id TEXT PRIMARY KEY, userProfileId TEXT, ingredientId INTEGER);

    INSERT INTO Account VALUES ('42', 'ADMIN'), ('99', 'USER');
    INSERT INTO UserProfile VALUES ('profile-1', 25000, 50, 120), ('profile-2', 5000, 10, 120);
    INSERT INTO Mail VALUES
      (1, '99', 'profile-1', '[6020019]', 'crafted reward', 1, 4),
      (2, '99', 'profile-1', '[3500093]', 'crafted hidden item', 0, 4),
      (3, '99', 'profile-2', '[3040001]', 'legitimate chair', 0, 4),
      (4, '99', 'profile-1', '[]', '1000', 1, 7),
      (5, '42', 'profile-2', '[]', '500', 0, 7),
      (6, '1', 'profile-2', '[4000001]', '', 0, 5),
      (7, '99', 'profile-1', 'not-json', '', 0, 4),
      (8, '42', 'profile-1', '[3040001]', '', 0, 10);
    INSERT INTO InventoryItem VALUES
      ('coin-reward', 'profile-1', 6020019, 1),
      ('hidden-statue', 'profile-1', 3500093, 1),
      ('invalid-food-king-chair', 'profile-1', 3040001, 1),
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

test('mail integrity cleanup reports and removes invalid mail while preserving valid mail and items', (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mail-integrity-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const databasePath = path.join(fixtureDir, 'fixture.db');
  createFixture(databasePath);

  const report = runCleanup(databasePath);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Invalid mails: 5 across 1 profiles \(2 opened\)/);
  assert.match(report.stdout, /invalid-gift-item: 2/);
  assert.match(report.stdout, /unauthorized-currency-mail: 1/);
  assert.match(report.stdout, /malformed-item-list: 1/);
  assert.match(report.stdout, /invalid-food-king-reward: 1/);
  assert.match(report.stdout, /Read-only: nothing changed/);

  const apply = runCleanup(databasePath, '--apply');
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Removed 5 invalid mails, reversed 3 gift grants/);
  assert.match(apply.stdout, /balances were not changed/);

  const db = new Database(databasePath, { readonly: true });
  assert.deepEqual(db.prepare('SELECT id FROM Mail ORDER BY id').all(), [{ id: 3 }, { id: 5 }, { id: 6 }]);
  assert.deepEqual(db.prepare('SELECT globalItemId FROM InventoryItem ORDER BY globalItemId').all(), [{ globalItemId: 3040001 }]);
  assert.equal(db.prepare("SELECT credits FROM UserProfile WHERE id = 'profile-1'").get().credits, 25000);
  db.close();
  assert.equal(fs.readdirSync(fixtureDir).filter((name) => name.startsWith('fixture.db.bak-')).length, 1);
});

test('optional reward revocation debits only opened invalid rewards and clamps balances', (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mail-reward-debit-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const databasePath = path.join(fixtureDir, 'fixture.db');
  createFixture(databasePath);

  const apply = runCleanup(databasePath, '--apply', '--revoke-opened-rewards');
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Debited 11000 coins, 0 PF cash, and 0 demand points across 1 profiles/);

  const db = new Database(databasePath, { readonly: true });
  assert.equal(db.prepare("SELECT credits FROM UserProfile WHERE id = 'profile-1'").get().credits, 14000);
  assert.equal(db.prepare("SELECT credits FROM UserProfile WHERE id = 'profile-2'").get().credits, 5000);
  db.close();
});
