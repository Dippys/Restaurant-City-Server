const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dbName = `.reference-data-cache-${process.pid}.db`;
const dbPath = path.join(root, dbName);
fs.writeFileSync(dbPath, '');
const pushEnv = { ...process.env }; delete pushEnv.RC_DB_PATH; delete pushEnv.DATABASE_URL;
const push = spawnSync(process.execPath, [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--url', `file:./${dbName}`], { cwd: root, env: pushEnv, encoding: 'utf8' });
assert.equal(push.status, 0, push.stderr || push.stdout);
process.env.RC_DB_PATH = dbPath;

const { prisma } = require('../dist/db/client.js');
const { pricepoints } = require('../dist/db/rpc-store.js');
const { upsertAdminPricepoint } = require('../dist/db/admin-store.js');
const { invalidateReferenceData, referenceCacheSnapshot } = require('../dist/reference-cache.js');

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(dbPath, { force: true });
});

test('economy RPC cache is reused and admin mutations invalidate it', async () => {
  invalidateReferenceData();
  const before = referenceCacheSnapshot();
  const initial = await pricepoints();
  assert.equal(initial.length > 0, true);
  await pricepoints();
  const cached = referenceCacheSnapshot();
  assert.equal(cached.misses - before.misses, 1);
  assert.equal(cached.hits - before.hits, 1);

  const row = initial[0];
  await upsertAdminPricepoint(row.id, {
    productType: row.productType, payoutParameter: row.payoutParameter,
    paymentProvider: row.paymentProvider, price: row.price + 7,
    currency: row.currency, currencyScale: row.currencyScale,
    clientData: row.clientData, token: row.token, enabled: row.enabled,
  });
  const refreshed = await pricepoints();
  assert.equal(refreshed.find((item) => item.id === row.id).price, row.price + 7);
  assert.equal(referenceCacheSnapshot().misses - before.misses, 2);
});
