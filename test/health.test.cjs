const test = require('node:test');
const assert = require('node:assert/strict');

const { DatabaseReadinessProbe } = require('../dist/health.js');

test('readiness probes coalesce concurrent calls and cache the result', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const probe = new DatabaseReadinessProbe(async () => {
    calls += 1;
    await gate;
  }, () => 1000, () => 1000);

  const checks = Array.from({ length: 20 }, () => probe.check());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.equal((await Promise.all(checks)).every((result) => result.status === 'ready'), true);
  assert.equal((await probe.check()).status, 'ready');
  assert.equal(calls, 1);
});

test('a timed-out readiness query remains the sole in-flight probe', async () => {
  let calls = 0;
  const never = new Promise(() => undefined);
  const probe = new DatabaseReadinessProbe(async () => {
    calls += 1;
    await never;
  }, () => 1, () => 5);
  assert.equal((await probe.check()).status, 'unavailable');
  assert.equal((await probe.check()).status, 'unavailable');
  assert.equal(calls, 1);
});
