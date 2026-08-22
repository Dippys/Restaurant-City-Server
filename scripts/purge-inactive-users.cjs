#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_DAYS = 30;

function parseArgs(argv) {
  const options = { apply: false, days: DEFAULT_DAYS, database: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--days') options.days = Number(argv[++index]);
    else if (arg === '--database') options.database = String(argv[++index] || '');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(options.days) || options.days < 1) {
    throw new Error('--days must be a positive whole number.');
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/purge-inactive-users.cjs
  node scripts/purge-inactive-users.cjs --apply

Options:
  --days N          Inactivity threshold in days (default: 30)
  --database PATH   SQLite file (default: RC_DB_PATH or server/dev.db)
  --apply           Create a backup, reassign workers, and delete stale users
  -h, --help        Show this help

Without --apply the script is read-only and prints the complete plan.`);
}

function parseTimestamp(value, label) {
  if (!value) return 0;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${label} timestamp: ${value}`);
  return timestamp;
}

function activityTimestamp(account) {
  return Math.max(
    parseTimestamp(account.createdAt, 'createdAt'),
    parseTimestamp(account.lastLoginAt, 'lastLoginAt'),
    parseTimestamp(account.sessionSeenAt, 'session lastSeenAt'),
  );
}

function buildPlan(db, cutoffMs) {
  const accounts = db.prepare(`
    SELECT a.*, MAX(s.lastSeenAt) AS sessionSeenAt
    FROM Account a
    LEFT JOIN Session s ON s.accountId = a.id
    GROUP BY a.id
  `).all().map((account) => ({ ...account, lastActiveMs: activityTimestamp(account) }));
  const profiles = db.prepare(`
    SELECT id, network, networkUid, playfishUid, firstName, fullName, restaurantName
    FROM UserProfile
  `).all();
  const profileByUid = new Map(profiles.map((profile) => [profile.networkUid, profile]));
  const accountUids = new Set(accounts.map((account) => account.networkUid));

  const staleAccounts = accounts
    .filter((account) => account.role !== 'ADMIN' && account.lastActiveMs < cutoffMs)
    .sort((left, right) => left.networkUid.localeCompare(right.networkUid));
  const staleUids = new Set(staleAccounts.map((account) => account.networkUid));
  const orphanProfiles = profiles
    .filter((profile) => profile.networkUid !== '1' && !accountUids.has(profile.networkUid))
    .sort((left, right) => left.networkUid.localeCompare(right.networkUid));
  for (const profile of orphanProfiles) staleUids.add(profile.networkUid);
  const staleProfileIds = new Set(
    staleAccounts.map((account) => profileByUid.get(account.networkUid)?.id).filter(Boolean),
  );
  for (const profile of orphanProfiles) staleProfileIds.add(profile.id);

  const candidates = accounts
    .filter((account) => !account.disabled && account.lastActiveMs >= cutoffMs && !staleUids.has(account.networkUid))
    .map((account) => ({ account, profile: profileByUid.get(account.networkUid) }))
    .filter((entry) => entry.profile)
    .sort((left, right) => left.account.networkUid.localeCompare(right.account.networkUid));

  const employees = db.prepare(`
    SELECT id, userProfileId, network, networkUid, playfishUid, happiness, task, notify
    FROM Employee
    ORDER BY userProfileId, networkUid
  `).all();
  const itemRefs = db.prepare(`
    SELECT id, userProfileId, employeeNetworkUid
    FROM OwnedItem
    WHERE length(employeeNetworkUid) > 0
    ORDER BY userProfileId, employeeNetworkUid, id
  `).all();
  const survivingProfiles = new Map(
    profiles.filter((profile) => !staleProfileIds.has(profile.id)).map((profile) => [profile.id, profile]),
  );

  const refsByRestaurant = new Map();
  function refGroup(ownerId, oldUid) {
    let restaurant = refsByRestaurant.get(ownerId);
    if (!restaurant) {
      restaurant = new Map();
      refsByRestaurant.set(ownerId, restaurant);
    }
    let group = restaurant.get(oldUid);
    if (!group) {
      group = { ownerId, oldUid, employee: null, itemCount: 0 };
      restaurant.set(oldUid, group);
    }
    return group;
  }

  for (const employee of employees) {
    if (survivingProfiles.has(employee.userProfileId) && staleUids.has(employee.networkUid)) {
      refGroup(employee.userProfileId, employee.networkUid).employee = employee;
    }
  }
  for (const item of itemRefs) {
    if (survivingProfiles.has(item.userProfileId) && staleUids.has(item.employeeNetworkUid)) {
      refGroup(item.userProfileId, item.employeeNetworkUid).itemCount += 1;
    }
  }

  const usage = new Map();
  for (const employee of employees) {
    if (survivingProfiles.has(employee.userProfileId) && !staleUids.has(employee.networkUid)) {
      usage.set(employee.networkUid, (usage.get(employee.networkUid) || 0) + 1);
    }
  }

  const reassignments = [];
  const blockers = [];
  for (const [ownerId, groups] of [...refsByRestaurant].sort(([a], [b]) => a.localeCompare(b))) {
    const owner = survivingProfiles.get(ownerId);
    const assigned = new Set(
      employees.filter((employee) => employee.userProfileId === ownerId).map((employee) => employee.networkUid),
    );
    for (const item of itemRefs) {
      if (item.userProfileId === ownerId) assigned.add(item.employeeNetworkUid);
    }

    for (const group of [...groups.values()].sort((a, b) => a.oldUid.localeCompare(b.oldUid))) {
      if (!group.employee) {
        blockers.push(`${owner.restaurantName} (${owner.networkUid}) has furniture assigned to stale user ${group.oldUid}, but no matching Employee row.`);
        continue;
      }
      const replacement = candidates
        .filter((entry) => entry.account.networkUid !== owner.networkUid && !assigned.has(entry.account.networkUid))
        .sort((left, right) => {
          const usageDelta = (usage.get(left.account.networkUid) || 0) - (usage.get(right.account.networkUid) || 0);
          return usageDelta || right.account.lastActiveMs - left.account.lastActiveMs || left.account.networkUid.localeCompare(right.account.networkUid);
        })[0];
      if (!replacement) {
        blockers.push(`${owner.restaurantName} (${owner.networkUid}) has no unique active replacement for stale employee ${group.oldUid}.`);
        continue;
      }
      assigned.add(replacement.account.networkUid);
      usage.set(replacement.account.networkUid, (usage.get(replacement.account.networkUid) || 0) + 1);
      reassignments.push({
        owner,
        oldUid: group.oldUid,
        employee: group.employee,
        itemCount: group.itemCount,
        replacement: replacement.profile,
        replacementUsername: replacement.account.username,
      });
    }
  }

  return { staleAccounts, orphanProfiles, staleProfileIds: [...staleProfileIds], reassignments, blockers };
}

function applyPlan(db, plan) {
  const now = new Date().toISOString();
  const updateEmployee = db.prepare(`
    UPDATE Employee
    SET id = ?, network = ?, networkUid = ?, playfishUid = ?, updatedAt = ?
    WHERE id = ?
  `);
  const updateItems = db.prepare(`
    UPDATE OwnedItem
    SET employeeNetwork = ?, employeeNetworkUid = ?, employeePlayfishUid = ?, updatedAt = ?
    WHERE userProfileId = ? AND employeeNetworkUid = ?
  `);

  for (const reassignment of plan.reassignments) {
    const replacement = reassignment.replacement;
    const newEmployeeId = `${reassignment.owner.id}:employee:${replacement.networkUid}`;
    updateEmployee.run(
      newEmployeeId,
      replacement.network,
      replacement.networkUid,
      replacement.playfishUid,
      now,
      reassignment.employee.id,
    );
    updateItems.run(
      replacement.network,
      replacement.networkUid,
      replacement.playfishUid,
      now,
      reassignment.owner.id,
      reassignment.oldUid,
    );
  }

  const deleteGrant = db.prepare('DELETE FROM SystemGrant WHERE userProfileId = ?');
  const deleteProfile = db.prepare('DELETE FROM UserProfile WHERE id = ?');
  const deleteAccount = db.prepare('DELETE FROM Account WHERE id = ?');
  for (const profileId of plan.staleProfileIds) {
    deleteGrant.run(profileId);
    deleteProfile.run(profileId);
  }
  for (const account of plan.staleAccounts) deleteAccount.run(account.id);
}

function printPlan(plan, cutoff) {
  console.log(`Cutoff: ${cutoff.toISOString()}`);
  console.log(`Stale non-admin accounts: ${plan.staleAccounts.length}`);
  for (const account of plan.staleAccounts) {
    console.log(`  DELETE ${account.username} (${account.networkUid}); last active ${new Date(account.lastActiveMs).toISOString()}`);
  }
  console.log(`Profiles without accounts (excluding protected UID 1): ${plan.orphanProfiles.length}`);
  for (const profile of plan.orphanProfiles) {
    console.log(`  DELETE PROFILE ${profile.firstName} / ${profile.restaurantName} (${profile.networkUid})`);
  }
  console.log(`Employee reassignments: ${plan.reassignments.length}`);
  for (const item of plan.reassignments) {
    console.log(`  ${item.owner.restaurantName} (${item.owner.networkUid}): ${item.oldUid} -> ${item.replacementUsername} (${item.replacement.networkUid}); furniture refs ${item.itemCount}`);
  }
  if (plan.blockers.length) {
    console.error(`Blockers: ${plan.blockers.length}`);
    for (const blocker of plan.blockers) console.error(`  ${blocker}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const serverDir = path.resolve(__dirname, '..');
  const databasePath = path.resolve(options.database || process.env.RC_DB_PATH || path.join(serverDir, 'dev.db'));
  if (!fs.existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  const cutoff = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
  const db = new Database(databasePath, { readonly: !options.apply, fileMustExist: true });
  db.pragma('foreign_keys = ON');

  try {
    if (!options.apply) {
      const plan = buildPlan(db, cutoff.getTime());
      printPlan(plan, cutoff);
      console.log(plan.blockers.length ? 'DRY RUN BLOCKED: repair the listed data or add active users before applying.' : 'DRY RUN ONLY: run again with --apply to execute this plan.');
      if (plan.blockers.length) process.exitCode = 2;
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${databasePath}.before-inactive-purge-${stamp}.bak`;
    await db.backup(backupPath);
    console.log(`Backup created: ${backupPath}`);

    db.exec('BEGIN IMMEDIATE');
    try {
      const plan = buildPlan(db, cutoff.getTime());
      printPlan(plan, cutoff);
      if (plan.blockers.length) throw new Error('Cleanup aborted because replacement blockers were found.');
      applyPlan(db, plan);
      db.exec('COMMIT');
      console.log(`APPLIED: reassigned ${plan.reassignments.length} employees, deleted ${plan.staleAccounts.length} inactive accounts, and deleted ${plan.staleProfileIds.length} profiles.`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

module.exports = { activityTimestamp, applyPlan, buildPlan, parseArgs };

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
