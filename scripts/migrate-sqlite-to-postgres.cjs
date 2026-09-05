#!/usr/bin/env node
'use strict';

// Offline, streaming SQLite -> PostgreSQL cutover. The source is opened
// read-only and COPY holds at most one SQLite row in application memory.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
const { Client } = require('pg');
const { from: copyFrom } = require('pg-copy-streams');

function parseArgs(argv) {
  const options = { sqlite: '', postgres: '', truncate: false, resume: false, skipSchema: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sqlite') options.sqlite = String(argv[++i] || '');
    else if (arg === '--postgres') options.postgres = String(argv[++i] || '');
    else if (arg === '--truncate') options.truncate = true;
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--skip-schema') options.skipSchema = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function help() {
  console.log(`Usage:
  npm run db:migrate:postgres -- --sqlite D:\\data\\restaurant.db --postgres "postgresql://user:pass@host/db"

The server must be stopped. RC_DB_PATH and DATABASE_URL may be used instead of flags.

Options:
  --resume       Resume a failed copy; complete tables are verified and skipped
  --truncate     Empty all application tables before copying (destructive)
  --skip-schema  Do not run Prisma db push before copying
  -h, --help     Show this help

The default refuses any non-empty PostgreSQL target. The SQLite file is never modified.`);
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function csv(value, dataType, onSanitizedNullBytes = () => {}) {
  if (value === null || value === undefined) return '\\N';
  let rendered = value;
  if (dataType === 'boolean') rendered = value === true || value === 1 || value === '1' ? 't' : 'f';
  else if (dataType === 'bytea') rendered = `\\x${Buffer.from(value).toString('hex')}`;
  else if (dataType.startsWith('timestamp') && typeof value === 'number') rendered = new Date(value).toISOString();
  else if (value instanceof Date) rendered = value.toISOString();
  if (typeof rendered === 'string' && ['text', 'character varying', 'character'].includes(dataType) && rendered.includes('\0')) {
    const count = rendered.split('\0').length - 1;
    onSanitizedNullBytes(count);
    // PostgreSQL text cannot represent U+0000. Preserve the corruption marker
    // visibly instead of silently dropping surrounding content.
    rendered = rendered.replace(/\0/g, '\uFFFD');
  }
  return `"${String(rendered).replace(/"/g, '""')}"`;
}

function createSchema(postgresUrl) {
  require('./generate-postgresql-schema.cjs');
  const prismaCli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'db', 'push', '--schema', 'prisma/schema.postgresql.prisma'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: postgresUrl },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`Prisma schema creation failed with exit code ${result.status ?? 'unknown'}.`);
}

async function targetMetadata(client) {
  const result = await client.query(`
    SELECT table_name, column_name, data_type, ordinal_position
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`);
  const tables = new Map();
  for (const row of result.rows) {
    const columns = tables.get(row.table_name) || [];
    columns.push({ name: row.column_name, type: row.data_type });
    tables.set(row.table_name, columns);
  }
  return tables;
}

async function dependencyOrder(client, tableNames) {
  const edges = await client.query(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_schema = tc.constraint_schema AND ccu.constraint_name = tc.constraint_name
     WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'`);
  const names = new Set(tableNames);
  const dependencies = new Map([...names].map((name) => [name, new Set()]));
  for (const { child, parent } of edges.rows) {
    if (names.has(child) && names.has(parent) && child !== parent) dependencies.get(child).add(parent);
  }
  const ordered = [];
  while (ordered.length < names.size) {
    const ready = [...names].filter((name) => !ordered.includes(name)
      && [...dependencies.get(name)].every((dependency) => ordered.includes(dependency)));
    if (ready.length === 0) throw new Error('PostgreSQL schema contains a foreign-key cycle; cannot determine safe COPY order.');
    ready.sort();
    ordered.push(...ready);
  }
  return ordered;
}

async function rowCount(client, table) {
  const result = await client.query(`SELECT count(*)::text AS count FROM ${quoteIdent(table)}`);
  return BigInt(result.rows[0].count);
}

async function copyTable(sqlite, client, table, targetColumns, sourceColumnNames) {
  const columns = targetColumns.filter((column) => sourceColumnNames.has(column.name));
  if (columns.length !== targetColumns.length) {
    const missing = targetColumns.filter((column) => !sourceColumnNames.has(column.name)).map((column) => column.name);
    throw new Error(`${table}: SQLite is missing target columns: ${missing.join(', ')}`);
  }
  const namesSql = columns.map((column) => quoteIdent(column.name)).join(', ');
  const selectSql = `SELECT ${namesSql} FROM ${quoteIdent(table)}`;
  const sink = client.query(copyFrom(`COPY ${quoteIdent(table)} (${namesSql}) FROM STDIN WITH (FORMAT csv, NULL '\\N')`));
  let copied = 0n;
  let bytes = 0;
  const sanitizedNullBytes = new Map();
  function *lines() {
    for (const row of sqlite.prepare(selectSql).iterate()) {
      const line = `${columns.map((column) => csv(row[column.name], column.type, (count) => {
        sanitizedNullBytes.set(column.name, (sanitizedNullBytes.get(column.name) || 0) + count);
      })).join(',')}\n`;
      bytes += Buffer.byteLength(line);
      copied += 1n;
      if (copied % 100000n === 0n) console.log(`    ${copied.toLocaleString()} rows copied`);
      yield line;
    }
  }
  // pipeline propagates a server-side COPY failure immediately, stops reading
  // SQLite, and lets the caller roll back the current table transaction.
  await pipeline(Readable.from(lines()), sink);
  for (const [column, count] of sanitizedNullBytes) {
    console.warn(`    warning: replaced ${count.toLocaleString()} NUL byte(s) in ${table}.${column} with U+FFFD`);
  }
  return { copied, bytes, sanitizedNullBytes };
}

async function resetSequences(client) {
  const sequences = await client.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`);
  for (const { table_name: table, column_name: column } of sequences.rows) {
    const sequence = await client.query('SELECT pg_get_serial_sequence($1, $2) AS name', [`public.${quoteIdent(table)}`, column]);
    if (!sequence.rows[0]?.name) continue;
    const maximum = await client.query(`SELECT max(${quoteIdent(column)})::text AS value FROM ${quoteIdent(table)}`);
    const value = maximum.rows[0].value;
    await client.query('SELECT setval($1::regclass, $2::bigint, $3)', [sequence.rows[0].name, value || '1', Boolean(value)]);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();
  if (options.resume && options.truncate) throw new Error('--resume and --truncate are mutually exclusive.');
  const sqlitePath = path.resolve(options.sqlite || process.env.RC_DB_PATH || 'dev.db');
  const postgresUrl = options.postgres || process.env.DATABASE_URL || '';
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite database not found: ${sqlitePath}`);
  if (!/^postgres(?:ql)?:\/\//i.test(postgresUrl)) throw new Error('Pass a PostgreSQL URL with --postgres or DATABASE_URL.');

  console.log(`SQLite source (read-only): ${sqlitePath}`);
  console.log(`PostgreSQL target: ${new URL(postgresUrl).host}/${new URL(postgresUrl).pathname.replace(/^\//, '')}`);
  if (!options.skipSchema) createSchema(postgresUrl);

  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  sqlite.pragma('query_only = ON');
  const client = new Client({ connectionString: postgresUrl, application_name: 'restaurant-city-offline-migration' });
  await client.connect();
  try {
    const sourceTables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'").all().map((row) => row.name));
    const metadata = await targetMetadata(client);
    const missing = [...sourceTables].filter((name) => !metadata.has(name));
    if (missing.length) throw new Error(`PostgreSQL schema is missing SQLite tables: ${missing.join(', ')}. Migration stopped rather than omit data.`);
    const tables = [...sourceTables];
    const order = await dependencyOrder(client, tables);

    if (options.truncate) {
      const names = order.map(quoteIdent).join(', ');
      if (names) await client.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
      console.log('PostgreSQL target tables truncated.');
    } else if (!options.resume) {
      for (const table of order) {
        if (await rowCount(client, table) !== 0n) throw new Error(`Target table ${table} is not empty. Use --resume or explicitly use --truncate.`);
      }
    }

    let totalRows = 0n;
    let totalBytes = 0;
    for (const table of order) {
      const sourceCount = BigInt(sqlite.prepare(`SELECT count(*) AS count FROM ${quoteIdent(table)}`).get().count);
      const existing = await rowCount(client, table);
      if (options.resume && existing === sourceCount) {
        console.log(`[skip] ${table}: ${sourceCount.toLocaleString()} rows already verified`);
        totalRows += sourceCount;
        continue;
      }
      if (existing !== 0n) throw new Error(`${table} has ${existing} target rows but ${sourceCount} source rows; restart with --truncate.`);
      const sourceColumns = new Set(sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((row) => row.name));
      console.log(`[copy] ${table}: ${sourceCount.toLocaleString()} rows`);
      await client.query('BEGIN');
      try {
        const result = await copyTable(sqlite, client, table, metadata.get(table), sourceColumns);
        const copiedCount = await rowCount(client, table);
        if (copiedCount !== sourceCount || result.copied !== sourceCount) {
          throw new Error(`${table} verification failed: source=${sourceCount}, streamed=${result.copied}, target=${copiedCount}`);
        }
        await client.query('COMMIT');
        totalRows += result.copied;
        totalBytes += result.bytes;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    await resetSequences(client);
    for (const table of order) {
      const source = BigInt(sqlite.prepare(`SELECT count(*) AS count FROM ${quoteIdent(table)}`).get().count);
      const target = await rowCount(client, table);
      if (source !== target) throw new Error(`Final verification failed for ${table}: SQLite=${source}, PostgreSQL=${target}`);
    }
    console.log(`Migration verified: ${totalRows.toLocaleString()} rows streamed (${(totalBytes / 1024 / 1024).toFixed(1)} MiB COPY payload).`);
    console.log('SQLite source was not modified. Set DATABASE_URL for the server, then run: npm run repair:mail-integrity -- --apply');
  } finally {
    sqlite.close();
    await client.end();
  }
}

module.exports = { parseArgs, csv, dependencyOrder };
if (require.main === module) main().catch((error) => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; });
