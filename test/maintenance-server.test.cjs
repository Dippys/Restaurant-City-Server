'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMaintenanceServer } = require('../scripts/maintenance-server.cjs');

async function withServer(run) {
  const server = createMaintenanceServer({ host: '127.0.0.1', port: 0, retryText: 'about an hour <maybe>', message: 'Testing <safe> maintenance.' });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('maintenance mode serves a safe branded 503 page on every browser route', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/game`);
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), null);
    assert.match(html, /We’ll be right back!/);
    assert.match(html, /Testing &lt;safe&gt; maintenance\./);
    assert.match(html, /about an hour &lt;maybe&gt;/);
    assert.match(html, /https:\/\/discord\.gg\/Bmgya8jua/);
    assert.doesNotMatch(html, /Testing <safe>/);
  });
});

test('numeric retry text is also sent as a valid Retry-After header', async () => {
  const server = createMaintenanceServer({ host: '127.0.0.1', port: 0, retryText: '600', message: 'Testing.' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.headers.get('retry-after'), '600');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('maintenance health endpoint stays monitorable and writes stay unavailable', async () => {
  await withServer(async (origin) => {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'maintenance' });

    const write = await fetch(`${origin}/__api/login`, { method: 'POST' });
    assert.equal(write.status, 503);
    assert.equal(write.headers.get('content-type'), 'application/json; charset=utf-8');
  });
});
