const test = require('node:test');
const assert = require('node:assert/strict');

const { BoundedExpiringCounters } = require('../dist/rate-limit.js');
const { MAX_BATCH_SUBREQUESTS, parseRequest } = require('../dist/rpc/codec.js');

test('rate-limit identity storage expires entries and enforces a hard cap', () => {
  const counters = new BoundedExpiringCounters(2);
  counters.set('one', { count: 1, resetAt: 100 }, 0);
  counters.set('two', { count: 1, resetAt: 200 }, 0);
  counters.set('three', { count: 1, resetAt: 300 }, 0);
  assert.equal(counters.size, 2);
  assert.equal(counters.get('one', 0), undefined, 'oldest entry should be evicted at the cap');
  assert.equal(counters.get('two', 250), undefined, 'expired entries should be discarded on access');
  assert.equal(counters.size, 1);
});

test('RPC batch parser rejects amplified and truncated batches before allocating work arrays', () => {
  const tooMany = Buffer.from([0, 255, 0, 0, MAX_BATCH_SUBREQUESTS + 1]);
  const oversized = parseRequest(tooMany);
  assert.match(oversized.error, /too many subrequests/);
  assert.equal(oversized.subs, undefined);

  const truncated = parseRequest(Buffer.from([0, 255, 0, 0, 1, 3, 5, 1]));
  assert.match(truncated.error, /batch subrequest body/);
  assert.equal(truncated.subs, undefined);
});

test('RPC parser rejects a tiny frame with an impossible session-string length', () => {
  const malformed = Buffer.from([0, 254, 0xff, 0xff, 0xff, 0xff, 0x7f]);
  const parsed = parseRequest(malformed);
  assert.match(parsed.error, /unexpected EOF while reading string/);
});
