const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const projectRoot = path.resolve(__dirname, '..');
const cleanupScript = path.join(projectRoot, 'scripts', 'remove-illegitimate-items.cjs');

function createFixture(databasePath) {
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE Account (networkUid TEXT, role TEXT);
    CREATE TABLE Mail (
      id INTEGER PRIMARY KEY,
      recipientProfileId TEXT,
      senderNetworkUid TEXT,
      globalItemIdsJson TEXT,
      type INTEGER,
      deleted INTEGER
    );
    CREATE TABLE InventoryItem (
      id TEXT PRIMARY KEY,
      userProfileId TEXT,
      globalItemId INTEGER,
      number INTEGER
    );
    CREATE TABLE OwnedItem (
      id TEXT PRIMARY KEY,
      userProfileId TEXT,
      globalItemId INTEGER
    );
    CREATE TABLE IngredientInventory (
      id TEXT PRIMARY KEY,
      userProfileId TEXT,
      globalItemId INTEGER,
      number INTEGER
    );
    CREATE TABLE GardenPlot (
      id TEXT PRIMARY KEY,
      userProfileId TEXT,
      ingredientId INTEGER
    );

    INSERT INTO Account VALUES ('42', 'ADMIN');
    INSERT INTO Mail VALUES (7, 'profile-1', '999', '[99999999]', 1, 0);
    INSERT INTO OwnedItem VALUES ('owned-1', 'profile-1', 99999999);
  `);
  db.close();
}

function runCleanup(databasePath, ...args) {
  return spawnSync(process.execPath, [cleanupScript, '--database', databasePath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

test('cleanup script scans and removes illegitimate owned items and mail', (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cleanup-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  const databasePath = path.join(fixtureDir, 'fixture.db');
  createFixture(databasePath);

  const report = runCleanup(databasePath);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Rows to remove: 1, exploit mail rows: 1/);
  assert.match(report.stdout, /Read-only: nothing changed/);

  const apply = runCleanup(databasePath, '--apply', '--purge-mail');
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Deleted 1 rows and 1 exploit mails/);

  const db = new Database(databasePath, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM OwnedItem').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Mail').get().count, 0);
  db.close();

  const backups = fs.readdirSync(fixtureDir).filter((name) => name.startsWith('fixture.db.bak-'));
  assert.equal(backups.length, 1);
});
