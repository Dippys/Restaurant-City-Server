import { randomInt } from 'node:crypto';
import { isOutdoorItemId } from '../db/item-catalog';

export const MAX_STREET_USERS = 10;
export const MAX_HIRE_CANDIDATES = 50;

// ---------------------------------------------------------------------------
// Gourmet Street scoring (ADR-0037)
//
// Who appears on Gourmet Street is a weighted combination of five signals, each
// normalized to 0..1 so no single signal dominates:
//
//   score = 0.25·furniture + 0.25·gourmet + 0.20·dishes + 0.15·outdoor +
//           0.15·votes
//
// - furniture: placed interior decorations (3xxxxxx item ids) that are neither
//   outdoor-flagged nor the fixed invisible trio (menu holder, achievement
//   panel, letter box) nor invisible awards; min(1, count / 60).
// - gourmet:   gourmet points on a log scale; min(1, ln(1+gp) / ln(1+1e6)) so
//   a few point-whales do not crush everyone else.
// - dishes:    sum of levels of the recipes currently on the menu (selected
//   recipe inventory items); min(1, sum / 100).
// - outdoor:   placed items from the shipped "Outdoor Only" group
//   (restaurant.xml `type="outdoor"`); min(1, count / 15).
// - votes:     rating average (totalMark / nbVote) scaled 1..5 -> 0..1,
//   multiplied by a vote-count saturation (1 - e^(-nbVote/5)) so a single
//   5-star vote cannot match many solid votes (1×5★ ≈ 0.18 vs 10×3.5★ ≈ 0.54).
//
// Selection: every enabled non-owner profile with score > 0 is ranked by score
// descending, ties broken by gourmet points then network uid, capped at 10.
// The old hard gates (level >= 10, gourmet points >= 100,000) are gone; the
// score itself is the gate, so a young community's Gourmet Street still fills
// with its most impressive restaurants instead of staying empty.
// ---------------------------------------------------------------------------

export const GOURMET_STREET_WEIGHT_FURNITURE = 0.25;
export const GOURMET_STREET_WEIGHT_GOURMET = 0.25;
export const GOURMET_STREET_WEIGHT_DISHES = 0.2;
export const GOURMET_STREET_WEIGHT_OUTDOOR = 0.15;
export const GOURMET_STREET_WEIGHT_VOTES = 0.15;

/** Interior placements that count as a "well-furnished" floor. */
export const GOURMET_STREET_REF_FURNITURE = 60;
/** Log-scale reference: a restaurant at this many gourmet points maxes the signal. */
export const GOURMET_STREET_REF_GOURMET = 1_000_000;
/** Sum of selected menu dish levels that maxes the dish signal (e.g. 10 dishes × level 10). */
export const GOURMET_STREET_REF_DISH_LEVELS = 100;
/** The outdoor-only catalog ships ~22 items; 15 is a densely planted strip. */
export const GOURMET_STREET_REF_OUTDOOR = 15;
/** Vote-count saturation constant: 5 votes → ~63% of the count factor, 10 → ~86%. */
export const GOURMET_STREET_VOTE_SATURATION = 5;

interface StreetRosterProfile {
  readonly networkUid: string;
  readonly playCount: number;
  readonly userLevel: number;
  readonly gourmetPoint: number;
}

export interface GourmetStreetProfile extends StreetRosterProfile {
  readonly nbVote: number;
  readonly totalMark: number;
  readonly ownedItems: readonly { readonly globalItemId: number }[];
  readonly inventoryItems: readonly {
    readonly globalItemId: number;
    readonly number: number;
    readonly isSelected: boolean;
  }[];
}

// Item id bands (GameUser.ITEM_TYPE_* million-digit mapping, defaults.ts):
// 2xxxxxx building facade, 3xxxxxx interior, 4xxxxxx ingredients, 5xxxxxx recipes.
const INTERIOR_ITEM_MIN = 3_000_000;
const INTERIOR_ITEM_MAX = 4_000_000;
const AWARD_ITEM_MIN = 3_400_000;
const RECIPE_ITEM_MIN = 5_000_000;
const RECIPE_ITEM_MAX = 6_000_000;
/** Invisible mandatory interior items every restaurant carries; not furniture. */
const FIXED_INTERIOR_ITEMS = new Set([3_100_000, 3_200_000, 3_300_000]);

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

/**
 * The votes signal: rating average scaled 1..5 → 0..1, attenuated by how few
 * votes back it. Zero votes scores 0 (an unrated restaurant is unknown, not
 * good); the saturation curve guarantees 10×3.5★ outranks 1×5★.
 */
export function gourmetStreetVoteScore(nbVote: number, totalMark: number): number {
  const votes = Math.max(0, Math.trunc(nbVote));
  if (votes === 0 || totalMark <= 0) {
    return 0;
  }
  const average = totalMark / votes;
  const averageNorm = Math.max(0, Math.min(1, (average - 1) / 4));
  return (1 - Math.exp(-votes / GOURMET_STREET_VOTE_SATURATION)) * averageNorm;
}

/** 0..1 Gourmet Street score for one profile (ADR-0037). */
export function gourmetStreetScore(
  profile: GourmetStreetProfile,
  isOutdoorItem: (globalItemId: number) => boolean = isOutdoorItemId,
): number {
  let furniture = 0;
  let outdoor = 0;
  for (const item of profile.ownedItems) {
    const id = item.globalItemId;
    if (
      id >= INTERIOR_ITEM_MIN && id < INTERIOR_ITEM_MAX &&
      id < AWARD_ITEM_MIN && !FIXED_INTERIOR_ITEMS.has(id)
    ) {
      if (isOutdoorItem(id)) {
        outdoor += 1;
      } else {
        furniture += 1;
      }
    }
  }

  let dishLevels = 0;
  for (const item of profile.inventoryItems) {
    if (item.isSelected && item.globalItemId >= RECIPE_ITEM_MIN && item.globalItemId < RECIPE_ITEM_MAX) {
      dishLevels += item.number;
    }
  }

  const gourmet = Math.min(
    1,
    Math.log1p(Math.max(0, profile.gourmetPoint)) / Math.log1p(GOURMET_STREET_REF_GOURMET),
  );

  return (
    GOURMET_STREET_WEIGHT_FURNITURE * Math.min(1, furniture / GOURMET_STREET_REF_FURNITURE) +
    GOURMET_STREET_WEIGHT_GOURMET * gourmet +
    GOURMET_STREET_WEIGHT_DISHES * Math.min(1, dishLevels / GOURMET_STREET_REF_DISH_LEVELS) +
    GOURMET_STREET_WEIGHT_OUTDOOR * Math.min(1, outdoor / GOURMET_STREET_REF_OUTDOOR) +
    GOURMET_STREET_WEIGHT_VOTES * gourmetStreetVoteScore(profile.nbVote, profile.totalMark)
  );
}

export function selectGourmetStreetProfiles<T extends GourmetStreetProfile>(
  profiles: readonly T[],
  ownerNetworkUid: string,
  requestedCount: number,
  isOutdoorItem: (globalItemId: number) => boolean = isOutdoorItemId,
): T[] {
  return profiles
    .map((profile) => ({ profile, score: gourmetStreetScore(profile, isOutdoorItem) }))
    .filter(({ profile, score }) => profile.networkUid !== ownerNetworkUid && score > 0)
    .sort((left, right) => (
      right.score - left.score ||
      right.profile.gourmetPoint - left.profile.gourmetPoint ||
      left.profile.networkUid.localeCompare(right.profile.networkUid)
    ))
    .map(({ profile }) => profile)
    .slice(0, rosterLimit(requestedCount, MAX_STREET_USERS));
}

function rosterLimit(requestedCount: number, maximumCount: number): number {
  if (!Number.isFinite(requestedCount)) {
    return 0;
  }
  return Math.min(maximumCount, Math.max(0, Math.trunc(requestedCount)));
}
