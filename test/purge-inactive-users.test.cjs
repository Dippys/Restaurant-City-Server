const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { applyPlan, buildPlan } = require('../scripts/purge-inactive-users.cjs');

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE Account (id TEXT PRIMARY KEY, username TEXT, networkUid TEXT, playfishUid INTEGER, role TEXT, disabled INTEGER, createdAt TEXT, lastLoginAt TEXT);
    CREATE TABLE Session (id TEXT PRIMARY KEY, accountId TEXT, lastSeenAt TEXT, FOREIGN KEY(accountId) REFERENCES Account(id) ON DELETE CASCADE);
    CREATE TABLE UserProfile (id TEXT PRIMARY KEY, network INTEGER, networkUid TEXT, playfishUid INTEGER, firstName TEXT, fullName TEXT, restaurantName TEXT);
    CREATE TABLE Employee (id TEXT PRIMARY KEY, userProfileId TEXT, network INTEGER, networkUid TEXT, playfishUid INTEGER, happiness INTEGER, task INTEGER, notify INTEGER, updatedAt TEXT, UNIQUE(userProfileId, networkUid), FOREIGN KEY(userProfileId) REFERENCES UserProfile(id) ON DELETE CASCADE);
    CREATE TABLE OwnedItem (id TEXT PRIMARY KEY, userProfileId TEXT, employeeNetwork INTEGER, employeeNetworkUid TEXT, employeePlayfishUid INTEGER, updatedAt TEXT, FOREIGN KEY(userProfileId) REFERENCES UserProfile(id) ON DELETE CASCADE);
    CREATE TABLE SystemGrant (id TEXT PRIMARY KEY, userProfileId TEXT);
  `);
  const account = db.prepare('INSERT INTO Account VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
  const profile = db.prepare('INSERT INTO UserProfile VALUES (?, 2, ?, ?, ?, ?, ?)');
  const recent = '2026-08-20T00:00:00.000Z';
  const stale = '2026-06-01T00:00:00.000Z';
  for (const row of [
    ['owner', 'Owner', '10', 10, 'USER', recent],
    ['other', 'Other', '11', 11, 'USER', recent],
    ['replacement', 'RealPerson', '12', 12, 'USER', recent],
    ['second-owner', 'SecondOwner', '13', 13, 'USER', recent],
    ['bot', 'OldBot', '99', 99, 'USER', stale],
    ['admin', 'Admin', '2', 2, 'ADMIN', stale],
  ]) {
    account.run(row[0], row[1], row[2], row[3], row[4], row[5], row[5]);
    profile.run(`facebook:${row[2]}`, row[2], row[3], row[1], row[1], `${row[1]}'s Restaurant`);
  }
  profile.run('facebook:1', '1', 1, 'Restaurant City', 'Restaurant City', 'Restaurant City');
  profile.run('facebook:1001', '1001', 1001, 'Mia', 'Mia Stone', "Mia's Restaurant");
  const employee = db.prepare('INSERT INTO Employee VALUES (?, ?, 2, ?, ?, ?, ?, 0, ?)');
  employee.run('owner:self', 'facebook:10', '10', 10, 1000, 0, recent);
  employee.run('owner:other', 'facebook:10', '11', 11, 2000, 1, recent);
  employee.run('owner:bot', 'facebook:10', '99', 99, 3456, 2, recent);
  employee.run('second:bot', 'facebook:13', '99', 99, 4567, 1, recent);
  db.prepare('INSERT INTO OwnedItem VALUES (?, ?, 2, ?, ?, ?)').run('chair', 'facebook:10', '99', 99, recent);
  db.prepare('INSERT INTO SystemGrant VALUES (?, ?)').run('bot:grant', 'facebook:99');
  return db;
}

test('reassigns stale employees uniquely per restaurant before deleting account and profile', () => {
  const db = fixture();
  const cutoff = Date.parse('2026-07-22T00:00:00.000Z');
  const plan = buildPlan(db, cutoff);
  assert.deepEqual(plan.staleAccounts.map((account) => account.networkUid), ['99']);
  assert.deepEqual(plan.orphanProfiles.map((profile) => profile.networkUid), ['1001']);
  assert.equal(plan.reassignments.length, 2);
  assert.equal(plan.blockers.length, 0);

  db.exec('BEGIN');
  applyPlan(db, plan);
  db.exec('COMMIT');

  assert.equal(db.prepare("SELECT count(*) n FROM Account WHERE networkUid = '99'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM UserProfile WHERE networkUid = '99'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM UserProfile WHERE networkUid = '1001'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM SystemGrant WHERE userProfileId = 'facebook:99'").get().n, 0);
  const ownerEmployees = db.prepare("SELECT networkUid, happiness, task FROM Employee WHERE userProfileId = 'facebook:10' ORDER BY networkUid").all();
  assert.equal(new Set(ownerEmployees.map((employee) => employee.networkUid)).size, ownerEmployees.length);
  assert.ok(ownerEmployees.some((employee) => employee.networkUid === '12' && employee.happiness === 3456 && employee.task === 2));
  assert.deepEqual(db.prepare("SELECT employeeNetworkUid, employeePlayfishUid FROM OwnedItem WHERE id = 'chair'").get(), { employeeNetworkUid: '12', employeePlayfishUid: 12 });
  assert.equal(db.prepare("SELECT count(*) n FROM UserProfile WHERE networkUid = '1'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM Account WHERE networkUid = '2'").get().n, 1);
  db.close();
});

test('reports a blocker instead of inventing state for a dangling furniture assignment', () => {
  const db = fixture();
  db.prepare('DELETE FROM Employee WHERE id = ?').run('owner:bot');
  const plan = buildPlan(db, Date.parse('2026-07-22T00:00:00.000Z'));
  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0], /no matching Employee row/);
  db.close();
});
