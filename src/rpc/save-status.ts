import type { SaveResult } from '../db/profile-store';

// Shipped RpcClient constants: STATUS_SAVE_FAIL=1 and
// SAVE_USER_PROFILE_FAIL_ALREADY_DONE=2.
export const SAVE_STATUS_OK = 0;
export const SAVE_STATUS_FAIL = 1;
export const SAVE_STATUS_ALREADY_DONE = 2;

export function saveStatusCode(status: SaveResult['status']): number {
  if (status === 'rejected') return SAVE_STATUS_FAIL;
  if (status === 'stale') return SAVE_STATUS_ALREADY_DONE;
  return SAVE_STATUS_OK;
}
