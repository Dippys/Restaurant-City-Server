import { PLAYER_NETWORK_UID, SYSTEM_NETWORK_UID } from '../db/defaults';

/**
 * The AS3 getAllFriends consumer expects the active player to be present so it
 * can replace that scalar response entry with GameWorld.gameUser. Keep the
 * owner first, followed by enabled account-backed hired friends in stable UID
 * order. Non-hired candidates come from the separate RPC 39 endpoint.
 */
export function friendRosterNetworkUids(enabledAccountUids: readonly string[], activeNetworkUid: string): string[] {
  const activeUid = activeNetworkUid || PLAYER_NETWORK_UID;
  const others = [...new Set(enabledAccountUids)]
    .filter((uid) => uid !== activeUid && uid !== PLAYER_NETWORK_UID && uid !== SYSTEM_NETWORK_UID)
    .sort((left, right) => left.localeCompare(right));
  return activeUid === SYSTEM_NETWORK_UID ? others : [activeUid, ...others];
}

export function hiredFriendRosterNetworkUids(
  enabledAccountUids: readonly string[],
  hiredNetworkUids: readonly string[],
  activeNetworkUid: string,
): string[] {
  const hired = new Set(hiredNetworkUids);
  return friendRosterNetworkUids(
    enabledAccountUids.filter((uid) => uid === activeNetworkUid || hired.has(uid)),
    activeNetworkUid,
  );
}

export function ownerFirst<T extends { readonly networkUid: string }>(profiles: readonly T[], activeNetworkUid: string): T[] {
  const byUid = new Map(profiles.map((profile) => [profile.networkUid, profile]));
  return friendRosterNetworkUids([...byUid.keys()], activeNetworkUid)
    .map((uid) => byUid.get(uid))
    .filter((profile): profile is T => profile !== undefined);
}
