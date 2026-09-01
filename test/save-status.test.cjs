const test = require('node:test');
const assert = require('node:assert/strict');

const { saveStatusCode } = require('../dist/rpc/save-status.js');

test('only a stale fence is already-done; persistence warnings are accepted upstream', () => {
  assert.equal(saveStatusCode('saved'), 0);
  assert.equal(saveStatusCode('duplicate'), 0);
  assert.equal(saveStatusCode('stale'), 2);
});
