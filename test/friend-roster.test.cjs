const test = require('node:test');
const assert = require('node:assert/strict');

const { friendRosterNetworkUids, hiredFriendRosterNetworkUids, ownerFirst } = require('../dist/rpc/friend-roster.js');

test('base roster helper contains the active owner first and excludes reserved profiles', () => {
  assert.deepEqual(
    friendRosterNetworkUids(['30', '1', '20', '0', '10', '20'], '20'),
    ['20', '10', '30'],
  );
});

test('ownerFirst preserves owner identity for RpcGetAllFriends replacement', () => {
  const profiles = [{ networkUid: '30' }, { networkUid: '20' }, { networkUid: '10' }];
  assert.deepEqual(ownerFirst(profiles, '20').map((profile) => profile.networkUid), ['20', '10', '30']);
});

test('Your Street roster contains only owner and distinct enabled hires', () => {
  assert.deepEqual(
    hiredFriendRosterNetworkUids(['10', '20', '30', '40'], ['30', '30', '99'], '20'),
    ['20', '30'],
  );
});
