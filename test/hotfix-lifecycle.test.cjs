const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const testDbPath = path.join(__dirname, '..', `.hotfix-lifecycle-${process.pid}.db`);
fs.writeFileSync(testDbPath, '');
process.env.RC_DB_PATH = testDbPath;

const { gracefulShutdown } = require('../dist/graceful-shutdown.js');

test.after(() => fs.rmSync(testDbPath, { force: true }));

test('graceful shutdown stops schedulers, drains an active request, flushes activity, and disconnects', async () => {
  let release;
  let requestStartedResolve;
  const requestStarted = new Promise((resolve) => { requestStartedResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const server = http.createServer(async (_req, res) => {
    requestStartedResolve();
    await gate;
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = fetch(`http://127.0.0.1:${port}/slow`);
  await requestStarted;
  let stopped = false;
  const shutdown = gracefulShutdown(server, [{ stop: () => { stopped = true; } }], 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const completed = await response;
  assert.equal(completed.status, 200);
  assert.equal(await completed.text(), 'ok');
  assert.deepEqual(await shutdown, { drained: true, activityFlushed: true });
  assert.equal(stopped, true);
  assert.equal(server.listening, false);
});
