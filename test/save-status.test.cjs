const test = require('node:test');
const assert = require('node:assert/strict');

const { saveStatusCode } = require('../dist/rpc/save-status.js');

test('save rejection is failure while a stale fence is already-done', () => {
  assert.equal(saveStatusCode('saved'), 0);
  assert.equal(saveStatusCode('duplicate'), 0);
  assert.equal(saveStatusCode('rejected'), 1);
  assert.equal(saveStatusCode('stale'), 2);
});
