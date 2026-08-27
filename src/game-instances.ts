// Per-player game instance tracking: only the newest instance of a player's
// game may keep running (hard kick). The game page claims an instance id on
// load and polls; if the server's active instance differs from its own, the
// page stops the player. See deploy/README.md notes and server/README.md.
const activeInstances = new Map<string, { instanceId: string; claimedAt: number }>();
const STALE_MS = 5 * 60 * 1000;

/** Register a game instance for a player. Returns true if it displaced a different instance. */
export function claimGameInstance(networkUid: string, instanceId: string): boolean {
  const now = Date.now();
  const previous = activeInstances.get(networkUid);
  const displaced = previous !== undefined && previous.instanceId !== instanceId;
  activeInstances.set(networkUid, { instanceId, claimedAt: now });
  return displaced;
}

/** The currently active game instance for a player (null when none/stale). */
export function activeGameInstance(networkUid: string): string | null {
  const entry = activeInstances.get(networkUid);
  if (!entry) return null;
  if (Date.now() - entry.claimedAt > STALE_MS) {
    activeInstances.delete(networkUid);
    return null;
  }
  return entry.instanceId;
}

/** Immediately invalidate a player's current browser game claim. */
export function terminateGameInstance(networkUid: string): boolean {
  return activeInstances.delete(networkUid);
}
