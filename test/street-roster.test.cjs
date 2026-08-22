const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectHireCandidateProfiles,
  selectGourmetStreetProfiles,
  selectRandomStreetProfiles,
} = require('../dist/rpc/street-roster.js');

const profiles = Array.from({ length: 15 }, (_, index) => ({
  networkUid: String(index + 1),
  playCount: 3,
  userLevel: index + 1,
  gourmetPoint: (index + 1) * 20_000,
}));

test('Random Street excludes owner and hired friends, caps at 10, and reshuffles', () => {
  const hired = new Set(['2', '4']);
  const first = selectRandomStreetProfiles(profiles, '1', hired, 50, () => 0);
  const second = selectRandomStreetProfiles(profiles, '1', hired, 50, (upper) => upper - 1);

  assert.equal(first.length, 10);
  assert.equal(second.length, 10);
  assert.ok(first.every((profile) => !hired.has(profile.networkUid) && profile.networkUid !== '1'));
  assert.ok(second.every((profile) => !hired.has(profile.networkUid) && profile.networkUid !== '1'));
  assert.notDeepEqual(first.map((profile) => profile.networkUid), second.map((profile) => profile.networkUid));
});

test('Hire candidates use a separate random non-hired pool', () => {
  const hired = new Set(['2', '4']);
  const largePool = Array.from({ length: 75 }, (_, index) => ({
    networkUid: String(index + 1),
    playCount: 1,
    userLevel: 1,
    gourmetPoint: 0,
  }));
  const candidates = selectHireCandidateProfiles(largePool, '1', hired, 100, () => 0);

  assert.equal(candidates.length, 50);
  assert.ok(candidates.every((profile) => !hired.has(profile.networkUid) && profile.networkUid !== '1'));
});

test('Gourmet Street requires level 10 and 100k points and caps at 10', () => {
  const selected = selectGourmetStreetProfiles(profiles, '1', 50);

  assert.equal(selected.length, 6);
  assert.ok(selected.every((profile) => profile.userLevel >= 10 && profile.gourmetPoint >= 100_000));
  assert.deepEqual(selected.map((profile) => profile.networkUid), ['15', '14', '13', '12', '11', '10']);
});
