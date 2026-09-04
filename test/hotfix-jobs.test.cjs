const test = require('node:test');
const assert = require('node:assert/strict');
const { JobRunner } = require('../dist/job-runner.js');

test('job runner skips same-job overlap and records bounded lifecycle state', async () => {
  const runner = new JobRunner();
  let release;
  let executions = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runner.run('moderation-cycle', async () => { executions += 1; await gate; return 42; });
  const second = await runner.run('moderation-cycle', async () => { executions += 1; return 99; });
  assert.equal(second.status, 'skipped-overlap');
  assert.equal(executions, 1);
  assert.equal(runner.snapshot()['moderation-cycle'].running, true);
  release();
  assert.deepEqual(await first, { status: 'completed', value: 42 });
  const state = runner.snapshot()['moderation-cycle'];
  assert.equal(state.running, false);
  assert.equal(state.runs, 1);
  assert.equal(state.skippedOverlaps, 1);
  assert.equal(typeof state.lastDurationMs, 'number');
  assert.ok(state.lastCompletedAt);
});

test('job failures are logged in state and a later run can retry', async () => {
  const runner = new JobRunner();
  await assert.rejects(runner.run('snapshot-pruning', async () => { throw new Error('temporary\nsecret-safe'); }), /temporary/);
  const failed = runner.snapshot()['snapshot-pruning'];
  assert.equal(failed.running, false);
  assert.equal(failed.lastError, 'temporary secret-safe');
  const retry = await runner.run('snapshot-pruning', async () => 'ok');
  assert.deepEqual(retry, { status: 'completed', value: 'ok' });
  assert.equal(runner.snapshot()['snapshot-pruning'].lastError, '');
});

