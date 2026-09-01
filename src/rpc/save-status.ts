import type { SaveResult } from '../db/profile-store';

// Shipped RpcClient constants. Persistence warnings are accepted and surfaced
// to moderation; only a genuine stale fence returns already-done.
export const SAVE_STATUS_OK = 0;
export const SAVE_STATUS_ALREADY_DONE = 2;

export function saveStatusCode(status: SaveResult['status']): number {
  if (status === 'stale') return SAVE_STATUS_ALREADY_DONE;
  return SAVE_STATUS_OK;
}
