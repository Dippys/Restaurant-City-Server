import { randomInt } from 'node:crypto';

export const MAX_STREET_USERS = 10;
export const MAX_HIRE_CANDIDATES = 50;
export const GOURMET_STREET_MIN_LEVEL = 10;
export const GOURMET_STREET_MIN_POINTS = 100_000;

interface StreetRosterProfile {
  readonly networkUid: string;
  readonly playCount: number;
  readonly userLevel: number;
  readonly gourmetPoint: number;
}

export function selectRandomStreetProfiles<T extends StreetRosterProfile>(
  profiles: readonly T[],
  ownerNetworkUid: string,
  friendNetworkUids: ReadonlySet<string>,
  requestedCount: number,
  randomIndex: (upperExclusive: number) => number = randomInt,
): T[] {
  return selectRandomNonFriendProfiles(
    profiles,
    ownerNetworkUid,
    friendNetworkUids,
    requestedCount,
    MAX_STREET_USERS,
    randomIndex,
  );
}

export function selectHireCandidateProfiles<T extends StreetRosterProfile>(
  profiles: readonly T[],
  ownerNetworkUid: string,
  friendNetworkUids: ReadonlySet<string>,
  requestedCount: number,
  randomIndex: (upperExclusive: number) => number = randomInt,
): T[] {
  return selectRandomNonFriendProfiles(
    profiles,
    ownerNetworkUid,
    friendNetworkUids,
    requestedCount,
    MAX_HIRE_CANDIDATES,
    randomIndex,
  );
}

function selectRandomNonFriendProfiles<T extends StreetRosterProfile>(
  profiles: readonly T[],
  ownerNetworkUid: string,
  friendNetworkUids: ReadonlySet<string>,
  requestedCount: number,
  maximumCount: number,
  randomIndex: (upperExclusive: number) => number,
): T[] {
  const eligible = profiles.filter((profile) => (
    profile.networkUid !== ownerNetworkUid && !friendNetworkUids.has(profile.networkUid)
  ));

  for (let index = eligible.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [eligible[index], eligible[swapIndex]] = [eligible[swapIndex]!, eligible[index]!];
  }

  return eligible.slice(0, rosterLimit(requestedCount, maximumCount));
}

export function selectGourmetStreetProfiles<T extends StreetRosterProfile>(
  profiles: readonly T[],
  ownerNetworkUid: string,
  requestedCount: number,
): T[] {
  return profiles
    .filter((profile) => (
      profile.networkUid !== ownerNetworkUid &&
      profile.userLevel >= GOURMET_STREET_MIN_LEVEL &&
      profile.gourmetPoint >= GOURMET_STREET_MIN_POINTS
    ))
    .sort((left, right) => (
      right.gourmetPoint - left.gourmetPoint || left.networkUid.localeCompare(right.networkUid)
    ))
    .slice(0, rosterLimit(requestedCount, MAX_STREET_USERS));
}

function rosterLimit(requestedCount: number, maximumCount: number): number {
  if (!Number.isFinite(requestedCount)) {
    return 0;
  }
  return Math.min(maximumCount, Math.max(0, Math.trunc(requestedCount)));
}
