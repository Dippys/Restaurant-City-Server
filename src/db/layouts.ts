/**
 * Layout unlock rules for the save path (ADR-0038).
 *
 * Spec: `GameWorld.LEVEL_THRESHOLDS`
 * (`decompiled/game/scripts/com/playfish/games/cooking/GameWorld.as`) — the
 * `layouts` column is `1` while the level index is 0..9, `2` for 10..19 and
 * `3` from 20 onward (the client treats the array index as the level:
 * `RestaurantLayoutChooser.getLayoutUnlockLevel` returns the first index
 * whose `layouts` exceeds the layout, and `LEVEL_THRESHOLDS[level.value].
 * layouts` is the current count). The client stores the active layout as
 * `layoutIndex * 2` in the profile (`WorldRestaurantEditor.setLayout`), so
 * layout L's room indexes are `2L` (interior) and `2L + 1` (outside area),
 * and `GameUser.activeFloorIndex` is `0`, `2` or `4` for layouts 1/2/3.
 */
export function maxLayoutsForLevel(level: number): number {
  return level >= 20 ? 3 : level >= 10 ? 2 : 1;
}

/** The largest valid `activeFloorIndex` (`(layouts - 1) * 2`) for a level. */
export function maxActiveFloorIndexForLevel(level: number): number {
  return (maxLayoutsForLevel(level) - 1) * 2;
}

/**
 * Clamps a profile's `activeFloorIndex` to the layouts its level unlocks and
 * forces the even `layout * 2` encoding. A legitimate client only ever sends
 * 0/2/4 within its unlocked layouts, so this is a no-op for normal saves and
 * only normalizes modified-client values (early layouts, odd room indexes).
 */
export function sanitizeActiveFloorIndex(value: number, fallback: number, level: number): number {
  const bounded = Number.isInteger(value) && value >= 0 && value <= 8
    ? value
    : (Number.isInteger(fallback) ? fallback : 0);
  const clamped = Math.min(bounded, maxActiveFloorIndexForLevel(level));
  return clamped - (clamped % 2);
}
