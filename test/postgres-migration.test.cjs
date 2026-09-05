'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseArgs, csv, dependencyOrder } = require('../scripts/migrate-sqlite-to-postgres.cjs');
const { renderPostgresqlSchema } = require('../scripts/generate-postgresql-schema.cjs');

test('PostgreSQL schema is a synchronized provider variant of the SQLite model', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');
  const generated = fs.readFileSync(path.join(root, 'prisma', 'schema.postgresql.prisma'), 'utf8');
  assert.equal(generated, renderPostgresqlSchema(source));
  assert.match(generated, /provider = "postgresql"/);
  assert.match(generated, /output\s+= "\.\.\/generated\/postgresql"/);
});

test('COPY CSV rendering preserves null, booleans, blobs, quotes, and newlines', () => {
  assert.equal(csv(null, 'text'), '\\N');
  assert.equal(csv(1, 'boolean'), '"t"');
  assert.equal(csv(0, 'boolean'), '"f"');
  assert.equal(csv(Buffer.from([0, 255]), 'bytea'), '"\\x00ff"');
  assert.equal(csv('say "hi"\nnext', 'text'), '"say ""hi""\nnext"');
  let sanitized = 0;
  assert.equal(csv('bad\0event\0text', 'text', (count) => { sanitized += count; }), '"bad�event�text"');
  assert.equal(sanitized, 2);
});

test('migration flags require explicit destructive or resume choices', () => {
  assert.deepEqual(parseArgs(['--sqlite', 'source.db', '--postgres', 'postgresql://db/x', '--resume']), {
    sqlite: 'source.db', postgres: 'postgresql://db/x', truncate: false, resume: true, skipSchema: false, help: false,
  });
  assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
});

test('dependency order places referenced tables before child tables', async () => {
  const client = { query: async () => ({ rows: [
    { child: 'Mail', parent: 'UserProfile' },
    { child: 'UserProfile', parent: 'Account' },
  ] }) };
  assert.deepEqual(await dependencyOrder(client, ['Mail', 'Account', 'UserProfile']), ['Account', 'UserProfile', 'Mail']);
});
