import type { Employee, FriendVisit, GardenPlot, IngredientInventory, InventoryItem, OwnedItem, RestaurantFloor, UserProfile, Prisma } from '@prisma/client';
import { prisma } from './client';
import { pricePurchases, priceSales } from './purchase-pricing';
import { sanitizeActiveFloorIndex } from './layouts';
import {
  FACEBOOK_NETWORK,
  PLAYER_NETWORK_UID,
  SYSTEM_NETWORK_UID,
  STARTER_FRIENDS,
  STARTER_BUILDING_ITEMS,
  STARTER_RESTAURANT_ITEMS,
  STARTER_RECIPES,
  STARTER_INGREDIENTS,
  DEFAULT_NEW_PLAYER_DEMAND,
  type FriendProfileSeed,
  type OwnedItemSeed,
  defaultProfileName,
} from './defaults';
import type { ActiveAccount } from '../session';
import { hiredFriendRosterNetworkUids, ownerFirst } from '../rpc/friend-roster';
import { gardenIngredientForSeed } from '../rpc/garden-plot';
import { capturePreSaveSnapshotTx, recordAcceptedSaveTx, recordSaveEventFindingTx, scanPlayer } from '../moderation/service';
import { captureProfileSnapshotTx, type SnapshotPayloadV1 } from '../moderation/snapshots';
import { isNonEditableRestaurantEntitlementItem, isStackableItemId, isWallDecorationItemId } from './item-catalog';
import { levelForGourmet } from '../moderation/rules';

export type StoredProfile = UserProfile & {
  ownedItems: OwnedItem[];
  inventoryItems: InventoryItem[];
  ingredients: IngredientInventory[];
  gardenPlots: GardenPlot[];
  floors: RestaurantFloor[];
  employees: Employee[];
  visits: FriendVisit[];
};

export interface NetworkUidData {
  readonly network: number;
  readonly networkUid: string;
  readonly playfishUid: number;
}

export interface OwnedItemData {
  readonly serverId: number;
  readonly globalItemId: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly data: number;
  readonly roomIndex: number;
  readonly employee: NetworkUidData;
}

/**
 * A coin purchase recorded from the save audit (ADR-0035). The shipped client
 * deducts the price only from its local balance and sends no credit delta, so
 * the server prices these authoritatively at save-apply time.
 */
export interface PurchaseAuditData {
  readonly kind: 'owned' | 'inventory' | 'perk' | 'ingredient' | 'seed';
  /** Resolved item id (owned/inventory/perk/ingredient). */
  readonly itemId?: number;
  readonly qty: number;
  /** Raw item hash from the audit (`itemToken`) for inventory/perk buys. */
  readonly token?: string;
  /** The inventory/perk token did not resolve to a known shipped item. */
  readonly unresolved?: boolean;
}

/** A sale carried by actions 4/19. The shipped client sends no coin delta. */
export interface SaleAuditData {
  readonly kind: 'owned' | 'inventory';
  readonly itemId: number;
  readonly qty: number;
  readonly token: string;
  readonly serverId?: number;
}

export interface SavedProfileData {
  readonly id: NetworkUidData;
  readonly restaurantName: string;
  readonly gourmetPoint: number;
  readonly trashPoint: number;
  readonly demandPoint: number;
  readonly musicPlay: number;
  readonly isInStreet: boolean;
  readonly awards: Buffer | null;
  readonly userLevel: number;
  readonly activeFloorIndex: number;
}

export interface SaveAuditData {
  readonly saveVersion: number;
  readonly timeOnClient: number;
  readonly creditDelta: number;
  readonly newCredits: number | null;
  readonly upsertOwnedItems: readonly OwnedItemData[];
  readonly removeOwnedItemIds: readonly number[];
  readonly inventoryChanges: readonly InventoryItemData[];
  readonly bulkInventoryMoves: readonly BulkInventoryMoveData[];
  /**
   * Item/floor mutations in the exact order sent by the Flash client.
   * Older internal callers may omit this and use the grouped arrays above.
   */
  readonly orderedMutations?: readonly SaveMutation[];
  readonly ingredientChanges: readonly IngredientChangeData[];
  readonly lockIngredientChanges: readonly IngredientLockData[];
  readonly gardenChanges: readonly GardenChangeData[];
  readonly floorChanges: readonly FloorData[];
  readonly employeeChanges: readonly EmployeeData[];
  readonly openMailIds: readonly number[];
  readonly deleteMailIds: readonly number[];
  readonly visitedFriends: readonly NetworkUidData[];
  /** Coin purchases recorded from the audit (ADR-0035); empty/absent when none. */
  readonly purchases?: readonly PurchaseAuditData[];
  /** Sales priced and ownership-validated by the server (ADR-0045). */
  readonly sales?: readonly SaleAuditData[];
  /** ADR-0034: compact evidence about the client-supplied audit envelope. */
  readonly actionCount?: number;
  readonly unknownActionCount?: number;
  readonly actionTypeCounts?: Readonly<Record<string, number>>;
}

export interface SaveFence {
  readonly authSessionId?: string;
  readonly rpcSessionToken?: string;
  readonly payloadDigest?: string;
  /** The client profile carried the shipped local Dummy fallback identity. */
  readonly fallbackProfile?: boolean;
}

export interface SaveResult {
  readonly status: 'saved' | 'duplicate' | 'stale';
  readonly savedVersion: number;
}

export interface InventoryItemData {
  readonly globalItemId: number;
  readonly delta: number;
  readonly selected?: boolean;
}

export interface BulkInventoryMoveData {
  readonly floorIndex: number;
  readonly itemTypeId: number;
}

export interface IngredientChangeData {
  readonly globalItemId: number;
  readonly delta: number;
}

export interface IngredientLockData {
  readonly globalItemId: number;
  readonly isLocked: boolean;
}

export interface GardenChangeData {
  readonly plotId: number;
  readonly action: 'seed' | 'water' | 'harvest';
}

export interface FloorData {
  readonly floorIndex: number;
  readonly tiles: readonly number[];
}

export interface EmployeeData {
  readonly id: NetworkUidData;
  readonly happiness: number;
  readonly task: number;
  readonly notify: boolean;
  readonly remove?: boolean;
}

const profileInclude = {
  ownedItems: { orderBy: { serverId: 'asc' as const } },
  inventoryItems: { orderBy: { globalItemId: 'asc' as const } },
  ingredients: { orderBy: { globalItemId: 'asc' as const } },
  gardenPlots: { orderBy: { plotId: 'asc' as const } },
  floors: { orderBy: { floorIndex: 'asc' as const } },
  employees: { orderBy: { networkUid: 'asc' as const } },
  visits: { orderBy: { lastVisitedAt: 'desc' as const } },
};

const FLOOR_TILE_COUNT = 20 * 40;
const STARTER_FLOOR_INDEXES = [0, 1] as const;
const EMPLOYEE_MAX_WORK_TIME_MS = 4 * 60 * 60 * 1000;
const GARDEN_WETNESS_PER_WATER_SECONDS = 3 * 60 * 60;
const GARDEN_MAX_WETNESS_SECONDS = 9 * 60 * 60;
const GARDEN_PLOTS_BY_LEVEL = [
  0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 1, 1, 1,
  2, 2, 2, 2, 2,
  3, 3, 3, 3,
  4, 4,
  5, 5,
  6, 6,
  7, 7,
  8, 8,
  9,
] as const;

export function playerNetworkUid(): string {
  return PLAYER_NETWORK_UID;
}

export async function getPlayerProfile(account?: ActiveAccount): Promise<StoredProfile> {
  let profile: StoredProfile;
  if (account) {
    profile = await ensureProfile(account.networkUid, {
      firstName: account.username,
      fullName: account.username,
      playfishUid: account.playfishUid,
      restaurantName: `${account.username}'s Restaurant`,
      seedStarterItems: true,
    });
  } else {
    profile = await ensureProfile(PLAYER_NETWORK_UID, { seedStarterItems: true });
  }

  if (await prepareOwnedItemsForProfileDelivery(profile.networkUid)) {
    return ensureProfile(profile.networkUid, { seedStarterItems: true });
  }
  return profile;
}

/**
 * ADR-0042: read-only owner fetch for internal callers (street/gourmet/hire
 * rosters, cash purchases, mail, trades, init, balance). Delivery preparation
 * — negative-id renumbering, façade dedup, phantom cleanup — must run only when
 * the response actually reaches the client (`getUserProfile`), because the live
 * client keeps saving items under their original negative local uids and a
 * renumbering it never learns about makes the next save create a duplicate row.
 */
export async function readOwnerProfile(account?: ActiveAccount): Promise<StoredProfile> {
  if (account) {
    return ensureProfile(account.networkUid, {
      firstName: account.username,
      fullName: account.username,
      playfishUid: account.playfishUid,
      restaurantName: `${account.username}'s Restaurant`,
      seedStarterItems: true,
    });
  }
  return ensureProfile(PLAYER_NETWORK_UID, { seedStarterItems: true });
}

// Spec: decompiled/game/scripts/com/playfish/games/cooking/UserItem.as and
// WorldCustomiseBuilding.as. Local negative IDs restart at -1 on each SWF load;
// façade singleton groups replace their previous active item in the editor.
const FACADE_SINGLETON_GROUPS = new Set([201, 202, 205, 206, 207]);
const STARTER_FACADE_RECOVERY_SLOTS = STARTER_BUILDING_ITEMS
  .map((seed, index) => ({ seed, legacyServerId: -(index + 1), group: Math.floor(seed.id / 10_000) }))
  .filter((slot) => FACADE_SINGLETON_GROUPS.has(slot.group));
const STARTER_RESTAURANT_DOOR_RECOVERY_SLOT = (() => {
  const index = STARTER_RESTAURANT_ITEMS.findIndex((seed) => Math.floor(seed.id / 10_000) === 301);
  const seed = STARTER_RESTAURANT_ITEMS[index];
  if (!seed || index < 0) throw new Error('Starter restaurant Door is missing from defaults');
  return {
    seed,
    legacyServerId: -(STARTER_BUILDING_ITEMS.length + index + 1),
    group: 301,
  };
})();
const COLLISION_RECOVERY_SLOTS = [...STARTER_FACADE_RECOVERY_SLOTS, STARTER_RESTAURANT_DOOR_RECOVERY_SLOT];

/**
 * ADR-0039: fixes OwnedItem rows whose primary key `id` is out of sync with
 * their `serverId`. Legacy rows can hold `…:owned:<negative>` ids while
 * `serverId` was renumbered to a positive value, so a later client session
 * that generates that same negative local uid collides on the `id` unique
 * constraint during `ownedItem.upsert()` (the "Unique constraint failed on
 * the fields: (id)" save crash). When the correct deterministic id
 * (`owned:<serverId>`) is already taken, the row is renumbered to a fresh
 * positive pair. Returns the number of rows repaired.
 */
export async function repairOwnedItemKeyMismatches(
  tx: any,
  networkUid: string,
  profileId: string,
): Promise<number> {
  const rows: Array<{ id: string; serverId: number }> = await tx.ownedItem.findMany({
    where: { userProfileId: profileId },
    select: { id: true, serverId: true },
  });
  const mismatched = rows.filter((row) => row.id !== ownedItemKey(networkUid, row.serverId));
  if (mismatched.length === 0) {
    return 0;
  }

  const usedIds = new Set(rows.map((row) => row.id));
  const usedServerIds = new Set(rows.map((row) => row.serverId));
  let nextServerId = rows.reduce((max, row) => Math.max(max, row.serverId), 0) + 1;

  for (const row of mismatched) {
    const correctId = ownedItemKey(networkUid, row.serverId);
    if (!usedIds.has(correctId)) {
      // Raw SQL on purpose: Prisma's update() would auto-bump @updatedAt,
      // which changes the delivery's newest-kept façade ordering.
      await tx.$executeRaw`UPDATE "OwnedItem" SET "id" = ${correctId} WHERE "id" = ${row.id}`;
      usedIds.delete(row.id);
      usedIds.add(correctId);
    } else {
      while (usedIds.has(ownedItemKey(networkUid, nextServerId)) || usedServerIds.has(nextServerId)) {
        nextServerId += 1;
      }
      const freshId = ownedItemKey(networkUid, nextServerId);
      await tx.$executeRaw`UPDATE "OwnedItem" SET "id" = ${freshId}, "serverId" = ${nextServerId} WHERE "id" = ${row.id}`;
      usedIds.delete(row.id);
      usedIds.add(freshId);
      usedServerIds.add(nextServerId);
      nextServerId += 1;
    }
  }
  return mismatched.length;
}

/** Standalone per-profile repair (used by the migration script). */
export async function repairOwnedItemKeyMismatchesForProfile(networkUid: string): Promise<number> {
  const profileId = profileKey(networkUid);
  return prisma.$transaction((tx) => repairOwnedItemKeyMismatches(tx, networkUid, profileId));
}

export async function prepareOwnedItemsForProfileDelivery(networkUid: string): Promise<boolean> {
  const profileId = profileKey(networkUid);
  return prisma.$transaction(async (tx) => {
    let changed = false;
    // ADR-0039: stale negative ids must not collide with fresh client uids.
    const repairedKeys = await repairOwnedItemKeyMismatches(tx, networkUid, profileId);
    if (repairedKeys > 0) changed = true;
    const placed = await tx.ownedItem.findMany({
      where: { userProfileId: profileId },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { serverId: 'desc' }],
    });

    const activeSingletonGroups = new Set<number>();
    const duplicateIds: string[] = [];
    for (const item of placed) {
      const group = Math.floor(item.globalItemId / 10_000);
      if (!FACADE_SINGLETON_GROUPS.has(group)) continue;
      if (activeSingletonGroups.has(group)) duplicateIds.push(item.id);
      else activeSingletonGroups.add(group);
    }

    for (const id of duplicateIds) {
      const item = placed.find((candidate) => candidate.id === id);
      if (!item) continue;
      // Delivery preparation can run concurrently with another profile read
      // (notably admin rebuild + game boot). Treat a row already removed by
      // the other transaction as idempotent cleanup, not a failed rebuild.
      const deleted = await tx.ownedItem.deleteMany({ where: { id } });
      if (deleted.count > 0) {
        await changeInventoryItem(tx, profileId, networkUid, { globalItemId: item.globalItemId, delta: 1 });
        changed = true;
      }
    }

    const duplicateSet = new Set(duplicateIds);
    const survivingItems = placed.filter((item) => !duplicateSet.has(item.id));
    const inventoryGroups = new Set((await tx.inventoryItem.findMany({
      where: { userProfileId: profileId, number: { gt: 0 } },
      select: { globalItemId: true },
    })).map((item) => Math.floor(item.globalItemId / 10_000)));

    // ADR-0025/0026: absence alone is not corruption. Recover only when another
    // item occupies the exact negative slot originally assigned to this starter
    // singleton/door and the player owns no replacement from that group.
    const recoveries = COLLISION_RECOVERY_SLOTS.filter((slot) => {
      const hasPlacedItem = survivingItems.some((item) => Math.floor(item.globalItemId / 10_000) === slot.group);
      if (hasPlacedItem || inventoryGroups.has(slot.group)) return false;
      const collision = survivingItems.find((item) => item.serverId === slot.legacyServerId);
      return collision !== undefined && Math.floor(collision.globalItemId / 10_000) !== slot.group;
    });

    const negativeItems = survivingItems
      .filter((item) => item.serverId < 0)
      .sort((a, b) => b.serverId - a.serverId);
    if (negativeItems.length > 0 || recoveries.length > 0) {
      const maxPositive = await tx.ownedItem.findFirst({
        where: { userProfileId: profileId, serverId: { gt: 0 } },
        orderBy: { serverId: 'desc' },
        select: { serverId: true },
      });
      let nextServerId = (maxPositive?.serverId ?? 0) + 1;
      for (const item of negativeItems) {
        await tx.ownedItem.update({
          where: { id: item.id },
          data: { id: ownedItemKey(networkUid, nextServerId), serverId: nextServerId },
        });
        nextServerId += 1;
      }
      for (const { seed } of recoveries) {
        const serverId = nextServerId;
        await tx.ownedItem.create({
          data: {
            id: ownedItemKey(networkUid, serverId),
            userProfileId: profileId,
            serverId,
            globalItemId: seed.id,
            positionX: seed.x,
            positionY: seed.y,
            data: seed.data ?? 0,
            roomIndex: seed.roomIndex ?? 0,
            employeeNetwork: 0,
            employeeNetworkUid: '',
            employeePlayfishUid: 0,
          },
        });
        nextServerId += 1;
      }
      changed = true;
    }

    // ADR-0042: the renumber-on-internal-read loop left phantom copies of one
    // physical item (same item id at the same tile + room). Two identical
    // non-stackable items can never legitimately share a tile, so keep the
    // newest row and delete the phantoms. Exempt: stackable items
    // (Crate/Sake Keg/…), wall decorations (walls hold several items per
    // position), façade singleton groups (handled above), and non-restaurant
    // ranges — avatar wardrobe rows (1xxxxxx) and building layers (2xxxxxx)
    // legitimately pile up at one position.
    const byPlacement = new Map<string, Array<{ id: string; updatedAt: Date }>>();
    for (const item of survivingItems) {
      if (item.globalItemId < 3_000_000 || item.globalItemId >= 8_000_000) continue;
      if (isStackableItemId(item.globalItemId) || isWallDecorationItemId(item.globalItemId)) continue;
      if (FACADE_SINGLETON_GROUPS.has(Math.floor(item.globalItemId / 10_000))) continue;
      const key = `${item.globalItemId}:${item.positionX}:${item.positionY}:${item.roomIndex}`;
      const group = byPlacement.get(key);
      if (group) group.push(item);
      else byPlacement.set(key, [item]);
    }
    for (const group of byPlacement.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      for (const phantom of group.slice(1)) {
        const deleted = await tx.ownedItem.deleteMany({ where: { id: phantom.id } });
        if (deleted.count > 0) changed = true;
      }
    }

    return changed;
  });
}

export async function getProfiles(networkUids: readonly string[], activeNetworkUid = PLAYER_NETWORK_UID): Promise<StoredProfile[]> {
  await ensureStarterFriends();

  return prisma.userProfile.findMany({
    where: {
      networkUid: { in: networkUids.map((id) => id || PLAYER_NETWORK_UID) },
      NOT: { networkUid: activeNetworkUid },
    },
    include: profileInclude,
    orderBy: { networkUid: 'asc' },
  });
}

// Your Street roster: owner first, then distinct enabled account-backed players
// who are hired employees or explicit ADR-0020 friends. Hiring remains separate.
export async function getAllFriends(activeNetworkUid = PLAYER_NETWORK_UID): Promise<StoredProfile[]> {
  await ensureStarterFriends();
  const owner = await ensureProfile(activeNetworkUid);
  const hiredUids = owner.employees.map((employee) => employee.networkUid);
  const activeAccount = await prisma.account.findUnique({ where: { networkUid: activeNetworkUid }, select: { id: true } });
  const friendshipRows = activeAccount ? await prisma.friendship.findMany({
    where: { OR: [{ accountAId: activeAccount.id }, { accountBId: activeAccount.id }] },
    include: { accountA: { select: { id: true, networkUid: true } }, accountB: { select: { id: true, networkUid: true } } },
  }) : [];
  const friendUids = friendshipRows.map((friendship) => friendship.accountAId === activeAccount?.id ? friendship.accountB.networkUid : friendship.accountA.networkUid);
  const enabledAccounts = await prisma.account.findMany({
    where: {
      disabled: false,
      networkUid: { in: [activeNetworkUid, ...hiredUids, ...friendUids] },
    },
    select: { networkUid: true },
  });
  const rosterUids = hiredFriendRosterNetworkUids(
    enabledAccounts.map((account) => account.networkUid),
    [...hiredUids, ...friendUids],
    activeNetworkUid,
  );
  const profiles = await prisma.userProfile.findMany({
    where: {
      networkUid: { in: rosterUids },
    },
    include: profileInclude,
  });
  return ownerFirst(profiles, activeNetworkUid);
}

export async function ensureLoginAccount(account: ActiveAccount): Promise<StoredProfile> {
  await ensureStarterFriends();
  // ADR-0042: the login/signup response goes to the web page, not the SWF —
  // the game always fetches its own profile via getUserProfile (the delivery
  // path that renumbers negative ids and hands the result to the client).
  return readOwnerProfile(account);
}

export async function ensureStarterFriends(): Promise<void> {
  // Production communities use real account-backed profiles. Keep the legacy
  // six-NPC seed available only for explicit local/demo deployments; otherwise
  // a maintenance purge would recreate deleted profile-only bots on next read.
  if (process.env.RC_SEED_STARTER_FRIENDS !== 'true') {
    return;
  }
  for (const friend of STARTER_FRIENDS) {
    const existing = await prisma.userProfile.findUnique({
      where: { id: profileKey(friend.networkUid) },
      include: profileInclude,
    });

    if (!existing) {
      await createSeedProfile(friend);
      continue;
    }

    if (await repairStarterFriendProfile(friend, existing)) {
      continue;
    }

    if (existing.ownedItems.length === 0) {
      await prisma.ownedItem.createMany({
        data: seedOwnedItems(friend.networkUid, friend.ownedItems).map((item) => ({
          ...item,
          userProfileId: profileKey(friend.networkUid),
        })),
      });
      await ensureStarterFloors(friend.networkUid);
      continue;
    }

    if (await repairProfileState(friend.networkUid, existing, true)) {
      continue;
    }
  }
}

async function repairStarterFriendProfile(seed: FriendProfileSeed, profile: StoredProfile): Promise<boolean> {
  const data: { playCount?: number; gender?: number } = {};

  if (profile.playCount < 1) {
    data.playCount = seed.playCount;
  }

  if (profile.gender !== seed.gender) {
    data.gender = seed.gender;
  }

  if (Object.keys(data).length === 0) {
    return false;
  }

  await prisma.userProfile.update({
    where: { id: profileKey(seed.networkUid) },
    data,
  });

  return true;
}

export async function savePlayerProfile(
  profile: SavedProfileData,
  audit: SaveAuditData,
  fence: SaveFence = {},
): Promise<SaveResult> {
  const profileId = profileKey(profile.id.networkUid);
  await ensureProfile(profile.id.networkUid || PLAYER_NETWORK_UID);

  const acceptedAt = new Date();
  const result = await prisma.$transaction(async (tx): Promise<SaveResult> => {
    if (fence.authSessionId) {
      const claimed = await tx.session.updateMany({
        where: {
          id: fence.authSessionId,
          rpcSessionToken: fence.rpcSessionToken || '__missing_rpc_session__',
          rpcSaveVersion: audit.saveVersion - 1,
        },
        data: {
          rpcSaveVersion: audit.saveVersion,
          rpcSaveTime: audit.timeOnClient,
          rpcSaveDigest: fence.payloadDigest || '',
        },
      });

      if (claimed.count !== 1) {
        const receipt = await tx.session.findUnique({ where: { id: fence.authSessionId } });
        const sameRpcSession = receipt?.rpcSessionToken === fence.rpcSessionToken;
        const duplicate = sameRpcSession
          && receipt?.rpcSaveVersion === audit.saveVersion
          && receipt?.rpcSaveTime === audit.timeOnClient
          && receipt?.rpcSaveDigest === (fence.payloadDigest || '');
        return {
          status: duplicate ? 'duplicate' : 'stale',
          savedVersion: sameRpcSession
            ? (receipt?.rpcSaveVersion ?? 0)
            : Math.max(0, audit.saveVersion),
        };
      }
    }

    const current = await tx.userProfile.findUniqueOrThrow({ where: { id: profileId } });
    // RpcGetUserProfile's network-failure fallback is the shipped Dummy0
    // profile (level 11 / about 10,000 stored GP). The client may increment
    // that GP before saving, so use the impossible sub-threshold level/name
    // fingerprint rather than one exact total. It must never replace an owner.
    const fallbackOverwrite = Boolean(fence.fallbackProfile)
      || (isFallbackProfileValues(profile.restaurantName, profile.userLevel, profile.gourmetPoint)
        && !isFallbackProfileValues(current.restaurantName, current.userLevel, current.gourmetPoint));
    if (fallbackOverwrite && !isFallbackProfileValues(current.restaurantName, current.userLevel, current.gourmetPoint)) {
      // A failed profile RPC can leave the running Flash client holding a
      // complete Dummy0 world. A successful response is still required to
      // advance the per-session save fence, but none of that fallback state—
      // scalar or gameplay audit—may be persisted over a real owner.
      await recordSaveEventFindingTx(tx, profile.id.networkUid, {
        ruleId: 'FALLBACK_PROFILE_BLOCKED', severity: 'HIGH', score: 75,
        title: 'Client fallback profile was blocked',
        summary: `Save ${audit.saveVersion} carried the shipped fallback world; the player's authoritative profile was preserved.`,
        evidence: {
          saveVersion: audit.saveVersion, storedRestaurantName: current.restaurantName,
          storedLevel: current.userLevel, storedGourmetPoint: current.gourmetPoint,
          receivedRestaurantName: profile.restaurantName, receivedLevel: profile.userLevel,
          receivedGourmetPoint: profile.gourmetPoint,
        },
      }, acceptedAt);
      return { status: 'saved', savedVersion: audit.saveVersion };
    }
    const saneUserLevel = fallbackOverwrite
      ? current.userLevel
      : boundedIntOrFallback(profile.userLevel, current.userLevel, 1, 99);
    const saneGourmetPoint = fallbackOverwrite ? current.gourmetPoint : profile.gourmetPoint;
    // ADR-0038: the client stores activeFloorIndex as layout*2 (0/2/4) and
    // gates layouts by level; clamp modified-client values to the unlocked
    // layouts so a profile cannot hold an unearned or unrenderable layout.
    const saneActiveFloorIndex = sanitizeActiveFloorIndex(profile.activeFloorIndex, current.activeFloorIndex, saneUserLevel);
    const snapshotId = await capturePreSaveSnapshotTx(tx, profile.id.networkUid, audit.saveVersion);

    // Price valid client purchases authoritatively, but never discard the rest
    // of a player's save because one price/ownership check is suspicious. A
    // durable moderation event records the discrepancy for operator review.
    // When purchases exist, `newCredits` is ignored so an absolute balance
    // cannot bypass prices that are known.
    const pricing = await pricePurchases(audit.purchases ?? [], tx);
    const salePricing = await priceSales(audit.sales ?? [], profileId, tx);
    // Charge every purchase that could be priced even when another row in the
    // same batch needs review. One unknown token must not make all valid buys
    // in that save free.
    const chargeableCost = pricing.cost < 0 ? 0 : pricing.cost;
    const payableRevenue = salePricing.invalid || salePricing.revenue < 0 ? 0 : salePricing.revenue;
    const rawNextCredits = ((audit.purchases?.length ?? 0) > 0 || (audit.sales?.length ?? 0) > 0
      ? current.credits + audit.creditDelta
      : (audit.newCredits ?? current.credits + audit.creditDelta)) - chargeableCost + payableRevenue;
    const creditsOutOfRange = !Number.isSafeInteger(rawNextCredits) || rawNextCredits < 0 || rawNextCredits > 2_147_483_647;
    const nextCredits = Number.isSafeInteger(rawNextCredits)
      ? Math.max(0, Math.min(2_147_483_647, rawNextCredits))
      : current.credits;
    if (pricing.invalid || pricing.cost < 0 || salePricing.invalid || salePricing.revenue < 0 || creditsOutOfRange) {
      await recordSaveEventFindingTx(tx, profile.id.networkUid, {
        ruleId: 'SAVE_PRICING_WARNING', severity: 'HIGH', score: 70,
        title: 'Save required lossless pricing fallback',
        summary: `Save ${audit.saveVersion} was preserved, but one or more purchase, sale, or balance checks could not be applied normally.`,
        evidence: {
          saveVersion: audit.saveVersion, purchaseCount: audit.purchases?.length ?? 0,
          saleCount: audit.sales?.length ?? 0, purchasePricingInvalid: pricing.invalid,
          purchasePricingIssues: pricing.issues,
          salePricingInvalid: salePricing.invalid, authoritativeCost: pricing.cost,
          authoritativeRevenue: salePricing.revenue, previousCredits: current.credits,
          clientCreditDelta: audit.creditDelta, rawNextCredits, appliedCredits: nextCredits,
          actionTypeCounts: audit.actionTypeCounts ?? {},
        },
      }, acceptedAt);
    }

    await tx.userProfile.update({
      where: { id: profileId },
      data: {
        network: profile.id.network,
        networkUid: profile.id.networkUid || PLAYER_NETWORK_UID,
        playfishUid: profile.id.playfishUid,
        restaurantName: fallbackOverwrite ? current.restaurantName : profile.restaurantName,
        gourmetPoint: saneGourmetPoint,
        trashPoint: fallbackOverwrite ? current.trashPoint : profile.trashPoint,
        demandPoint: fallbackOverwrite ? current.demandPoint : profile.demandPoint,
        musicPlay: fallbackOverwrite ? current.musicPlay : profile.musicPlay,
        isInStreet: fallbackOverwrite ? current.isInStreet : profile.isInStreet,
        awards: fallbackOverwrite ? current.awards : (profile.awards ? new Uint8Array(profile.awards) : null),
        userLevel: saneUserLevel,
        activeFloorIndex: fallbackOverwrite ? current.activeFloorIndex : saneActiveFloorIndex,
        credits: nextCredits,
        saveVersion: audit.saveVersion + 1,
        lastSave: Math.floor(Date.now() / 1000),
      },
    });

    // ADR-0039: stale negative ids (legacy rows whose id does not match their
    // serverId) can collide with a fresh client uid in the create branch of
    // the upsert below ("Unique constraint failed on the fields: (id)"), which
    // previously aborted the whole save. Repair them before upserting.
    await repairOwnedItemKeyMismatches(tx, profile.id.networkUid, profileId);
    const placedItemsBefore = await tx.ownedItem.count({ where: { userProfileId: profileId } });
    const orderedMutations = audit.orderedMutations;
    if (orderedMutations) {
      await applyOrderedSaveMutations(tx, profileId, profile.id.networkUid, orderedMutations);
    } else {
      for (const serverId of audit.removeOwnedItemIds) {
        await tx.ownedItem.deleteMany({ where: { userProfileId: profileId, serverId } });
      }
      for (const item of audit.upsertOwnedItems) {
        await upsertOwnedItemReconciled(tx, profileId, profile.id.networkUid, item);
      }
      for (const change of audit.inventoryChanges) {
        await changeInventoryItem(tx, profileId, profile.id.networkUid, change);
      }
      for (const move of audit.bulkInventoryMoves) {
        await moveInGameItemsToInventory(tx, profileId, profile.id.networkUid, move);
      }
    }

    for (const change of audit.ingredientChanges) {
      await changeIngredient(tx, profileId, profile.id.networkUid, change);
    }

    for (const change of audit.lockIngredientChanges) {
      // GameUser.removeIngredient removes a row at count 0. A stale lock audit
      // must not recreate a visible zero-count ingredient on the next reload.
      await tx.ingredientInventory.updateMany({
        where: { userProfileId: profileId, globalItemId: change.globalItemId, number: { gt: 0 } },
        data: { isLocked: change.isLocked },
      });
    }

    for (const change of audit.gardenChanges) {
      await applyGardenChange(tx, profileId, profile.id.networkUid, saneUserLevel, change);
    }

    if (!orderedMutations) {
      for (const floor of audit.floorChanges) {
        await upsertRestaurantFloor(tx, profileId, profile.id.networkUid, floor);
      }
    }

    if (audit.floorChanges.length > 0 || orderedMutations?.some((mutation) => mutation.kind === 'floor')) {
      await ensureFloorTileInventoryCounts(tx, profileId, profile.id.networkUid);
    }

    const placedItemsAfter = await tx.ownedItem.count({ where: { userProfileId: profileId } });
    const removedPlacedItems = placedItemsBefore - placedItemsAfter;
    if (removedPlacedItems >= 20 && placedItemsAfter * 2 <= placedItemsBefore) {
      await recordSaveEventFindingTx(tx, profile.id.networkUid, {
        ruleId: 'LARGE_LAYOUT_CLEAR', severity: 'MEDIUM', score: 45,
        title: 'Large restaurant layout clear was saved',
        summary: `Save ${audit.saveVersion} reduced placed items from ${placedItemsBefore} to ${placedItemsAfter}; the pre-save snapshot remains available.`,
        evidence: {
          saveVersion: audit.saveVersion, snapshotId, placedItemsBefore,
          placedItemsAfter, removedPlacedItems,
          bulkMoveCount: audit.bulkInventoryMoves.length,
          actionCount: audit.actionCount ?? 0,
        },
      }, acceptedAt);
    }

    for (const employee of audit.employeeChanges) {
      const employeeNetworkUid = employee.id.networkUid || String(employee.id.playfishUid || '');
      if (!employeeNetworkUid) {
        continue;
      }
      if (employee.remove) {
        await tx.employee.deleteMany({ where: { userProfileId: profileId, networkUid: employeeNetworkUid } });
        continue;
      }
      await tx.employee.upsert({
        where: { userProfileId_networkUid: { userProfileId: profileId, networkUid: employeeNetworkUid } },
        update: {
          network: employee.id.network,
          playfishUid: employee.id.playfishUid,
          happiness: employeeWorkTime(employee),
          task: employee.task,
          notify: employee.notify,
        },
        create: {
          id: employeeKey(profile.id.networkUid, employeeNetworkUid),
          userProfileId: profileId,
          network: employee.id.network,
          networkUid: employeeNetworkUid,
          playfishUid: employee.id.playfishUid,
          happiness: employeeWorkTime(employee),
          task: employee.task,
          notify: employee.notify,
        },
      });
    }

    if (audit.openMailIds.length > 0) {
      await tx.mail.updateMany({
        where: { recipientProfileId: profileId, id: { in: [...audit.openMailIds] } },
        data: { read: true },
      });
    }

    if (audit.deleteMailIds.length > 0) {
      await tx.mail.updateMany({
        where: { recipientProfileId: profileId, id: { in: [...audit.deleteMailIds] } },
        data: { deleted: true },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const today = new Date(now * 1000).toISOString().slice(0, 10);
    for (const friend of audit.visitedFriends) {
      const friendNetworkUid = friend.networkUid || String(friend.playfishUid || '');
      if (!friendNetworkUid) {
        continue;
      }
      await tx.friendVisit.upsert({
        where: { userProfileId_friendNetworkUid: { userProfileId: profileId, friendNetworkUid } },
        update: {
          friendNetwork: friend.network,
          friendPlayfishUid: friend.playfishUid,
          lastVisitedAt: now,
          visitsTodayDate: today,
          visitsTodayCount: { increment: 1 },
        },
        create: {
          id: visitKey(profile.id.networkUid, friendNetworkUid),
          userProfileId: profileId,
          friendNetwork: friend.network,
          friendNetworkUid,
          friendPlayfishUid: friend.playfishUid,
          firstVisitedAt: now,
          lastVisitedAt: now,
          giftIngredientId: defaultVisitIngredient(friendNetworkUid),
          visitsTodayDate: today,
          visitsTodayCount: 1,
        },
      });
    }

    await repairProfileStateInTransaction(tx, profile.id.networkUid, profileId, true);

    await recordAcceptedSaveTx(tx, {
      networkUid: profile.id.networkUid,
      saveVersion: audit.saveVersion,
      clientTime: audit.timeOnClient,
      previousCredits: current.credits,
      credits: nextCredits,
      previousGourmet: current.gourmetPoint,
      gourmetPoint: saneGourmetPoint,
      previousLevel: current.userLevel,
      userLevel: saneUserLevel,
      audit,
      snapshotId,
      acceptedAt,
      rpcSessionToken: fence.rpcSessionToken ?? '',
    });

    return { status: 'saved', savedVersion: audit.saveVersion };
  });
  if (result.status === 'saved') {
    await scanPlayer(profile.id.networkUid).catch((error) => console.error('Post-save moderation scan failed:', error));
  }
  return result;
}

interface EnsureProfileOptions {
  readonly firstName?: string;
  readonly fullName?: string;
  readonly restaurantName?: string;
  readonly playfishUid?: number;
  readonly seedStarterItems?: boolean;
}

export type SaveMutation =
  | { readonly kind: 'removeOwned'; readonly serverId: number }
  | { readonly kind: 'upsertOwned'; readonly item: OwnedItemData }
  | { readonly kind: 'inventory'; readonly change: InventoryItemData }
  | { readonly kind: 'bulkInventory'; readonly move: BulkInventoryMoveData }
  | { readonly kind: 'floor'; readonly floor: FloorData };

/** Re-read and normalize the authoritative stored collections for an admin rebuild. */
export async function rebuildPlayerProfile(networkUid: string): Promise<StoredProfile> {
  const account = await prisma.account.findUnique({ where: { networkUid }, select: { username: true, playfishUid: true } });
  if (!account) throw new Error('Player account was not found.');
  return getPlayerProfile({ username: account.username, networkUid, playfishUid: account.playfishUid });
}

function isFallbackProfileValues(restaurantName: string, userLevel: number, gourmetPoint: number): boolean {
  return /^Dummy\d+$/i.test(restaurantName.trim()) && userLevel === 11 && gourmetPoint < 100_000;
}

function snapshotPayload(value: string): SnapshotPayloadV1 | null {
  try {
    const payload = JSON.parse(value) as SnapshotPayloadV1;
    return payload?.version === 1 && payload.profile ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Repairs the exact shipped fallback fingerprint from the most recent clean
 * pre-save snapshot. Only scalar profile fields are restored: later item,
 * coin, cash, ingredient, and employee state stays untouched.
 */
export async function recoverFallbackProfileScalars(networkUid: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.userProfile.findUnique({ where: { networkUid } });
    if (!current || !/^Dummy\d+$/i.test(current.restaurantName.trim())) {
      return false;
    }

    // Prefer the immutable snapshot linked to the level-11 Dummy transition.
    // The same bad client state can earn GP before the save (dev.db70 captured
    // 10,100 rather than exactly 10,000), so GP is not part of the fingerprint.
    const fallbackFact = await tx.profileSaveFact.findFirst({
      where: {
        networkUid,
        userLevel: 11,
        gourmetPoint: { lt: 100_000 },
        previousLevel: { not: 11 },
      },
      select: { snapshotId: true, gourmetPoint: true },
      orderBy: { createdAt: 'desc' },
    });
    const linkedSnapshot = fallbackFact?.snapshotId
      ? await tx.profileSnapshot.findUnique({ where: { id: fallbackFact.snapshotId }, select: { payloadJson: true } })
      : null;
    let clean = linkedSnapshot ? snapshotPayload(linkedSnapshot.payloadJson) : null;
    if (clean && /^Dummy\d+$/i.test(clean.profile.restaurantName.trim())) {
      clean = null;
    }

    // The exact current fingerprint is itself sufficient evidence for older
    // databases that predate save facts; use the newest clean snapshot.
    if (!clean && isFallbackProfileValues(current.restaurantName, current.userLevel, current.gourmetPoint)) {
      const snapshots = await tx.profileSnapshot.findMany({
        where: { networkUid },
        select: { payloadJson: true },
        orderBy: { createdAt: 'desc' },
        take: 250,
      });
      clean = snapshots
        .map((row) => snapshotPayload(row.payloadJson))
        .find((payload) => payload && !/^Dummy\d+$/i.test(payload.profile.restaurantName.trim())) ?? null;
    }
    if (!clean) {
      return false;
    }

    // Preserve only GP earned after the bad save; the fallback's built-in
    // 10,000-ish GP is not player progress.
    const postFallbackGain = fallbackFact
      ? Math.max(0, current.gourmetPoint - fallbackFact.gourmetPoint)
      : 0;
    const recoveredGourmetPoint = clean.profile.gourmetPoint + postFallbackGain;
    const recoveredUserLevel = Math.max(
      clean.profile.userLevel,
      Math.max(1, levelForGourmet(Math.floor(recoveredGourmetPoint / 10))),
    );

    await captureProfileSnapshotTx(tx, networkUid, 'AUTO_BEFORE_FALLBACK_RECOVERY', 'Before restoring Dummy fallback scalars');
    await tx.userProfile.update({
      where: { id: current.id },
      data: {
        restaurantName: clean.profile.restaurantName,
        userLevel: recoveredUserLevel,
        gourmetPoint: recoveredGourmetPoint,
        trashPoint: clean.profile.trashPoint,
        demandPoint: clean.profile.demandPoint,
        musicPlay: clean.profile.musicPlay,
        isInStreet: clean.profile.isInStreet,
        activeFloorIndex: clean.profile.activeFloorIndex,
        awards: clean.profile.awardsBase64
          ? new Uint8Array(Buffer.from(clean.profile.awardsBase64, 'base64'))
          : null,
      },
    });
    return true;
  });
}

async function ensureProfile(networkUid: string, options: EnsureProfileOptions = {}): Promise<StoredProfile> {
  const safeNetworkUid = networkUid || PLAYER_NETWORK_UID;
  const id = profileKey(safeNetworkUid);
  const existing = await prisma.userProfile.findUnique({
    where: { id },
    include: profileInclude,
  });

  if (existing) {
    if (/^Dummy\d+$/i.test(existing.restaurantName.trim()) && await recoverFallbackProfileScalars(safeNetworkUid)) {
      return ensureProfile(safeNetworkUid, options);
    }

    if (needsProfileRepair(existing)) {
      await prisma.userProfile.update({
        where: { id },
        data: {
          userLevel: boundedIntOrFallback(existing.userLevel, 1, 1, 99),
          activeFloorIndex: boundedIntOrFallback(existing.activeFloorIndex, 0, 0, 8),
          awards: null,
        },
      });

      return ensureProfile(safeNetworkUid, options);
    }

    if (await repairProfileState(safeNetworkUid, existing, Boolean(options.seedStarterItems))) {
      return ensureProfile(safeNetworkUid, options);
    }

    return existing;
  }

  const { firstName, fullName } = defaultProfileName(safeNetworkUid);
  const numericUid = Number.parseInt(safeNetworkUid, 10);
  const playfishUid = options.playfishUid ?? (Number.isFinite(numericUid) ? numericUid : 0);

  await prisma.userProfile.create({
    data: {
      id,
      network: FACEBOOK_NETWORK,
      networkUid: safeNetworkUid,
      playfishUid,
      firstName: options.firstName ?? firstName,
      fullName: options.fullName ?? fullName,
      restaurantName: options.restaurantName ?? (safeNetworkUid === PLAYER_NETWORK_UID ? 'My Restaurant' : firstName),
      gender: 0,
      credits: 0,
      // playCount starts at 1 so the first session takes the client's fresh-user
      // boot branch (demand 120, money 0). It is advanced by initSession only
      // after tutorial progress exists, never by ordinary save traffic.
      playCount: options.seedStarterItems ? 1 : 0,
      userLevel: 1,
      gourmetPoint: 0,
      trashPoint: 0,
      demandPoint: options.seedStarterItems ? DEFAULT_NEW_PLAYER_DEMAND : 0,
      musicPlay: 0,
      ownedItems: {
        create: options.seedStarterItems ? seedOwnedItems(safeNetworkUid, starterSeeds()) : [],
      },
      inventoryItems: {
        create: options.seedStarterItems ? seedStarterRecipes(safeNetworkUid) : [],
      },
      ingredients: {
        create: options.seedStarterItems ? seedStarterIngredients(safeNetworkUid) : [],
      },
      floors: {
        create: options.seedStarterItems ? seedStarterFloors(safeNetworkUid) : [],
      },
    },
  });

  return prisma.userProfile.findUniqueOrThrow({
    where: { id },
    include: profileInclude,
  });
}

function ownedItemWriteData(item: OwnedItemData) {
  return {
    serverId: item.serverId,
    globalItemId: item.globalItemId,
    positionX: item.positionX,
    positionY: item.positionY,
    data: item.data,
    roomIndex: item.roomIndex,
    employeeNetwork: item.employee.network,
    employeeNetworkUid: item.employee.networkUid,
    employeePlayfishUid: item.employee.playfishUid,
  };
}

/**
 * ADR-0042: a negative local uid with no matching row means the row was
 * renumbered by an earlier delivery the client never saw. Re-create it only
 * when no physical twin exists (same item at the same tile + room) — otherwise
 * update the twin in place, so one physical item can never become two rows.
 * Stackable items, wall decorations, and façade singletons can legitimately
 * share a position and keep the plain create path.
 */
async function upsertOwnedItemReconciled(
  tx: Prisma.TransactionClient,
  profileId: string,
  networkUid: string,
  item: OwnedItemData,
): Promise<void> {
  const existing = await tx.ownedItem.findUnique({
    where: { userProfileId_serverId: { userProfileId: profileId, serverId: item.serverId } },
    select: { id: true },
  });
  const sharesPositionLegitimately = item.serverId >= 0
    || item.globalItemId < 3_000_000
    || item.globalItemId >= 8_000_000
    || isStackableItemId(item.globalItemId)
    || isWallDecorationItemId(item.globalItemId)
    || FACADE_SINGLETON_GROUPS.has(Math.floor(item.globalItemId / 10_000));
  if (existing || sharesPositionLegitimately) {
    await tx.ownedItem.upsert({
      where: { userProfileId_serverId: { userProfileId: profileId, serverId: item.serverId } },
      update: ownedItemWriteData(item),
      create: {
        id: ownedItemKey(networkUid, item.serverId),
        userProfileId: profileId,
        ...ownedItemWriteData(item),
      },
    });
    return;
  }

  const twin = await tx.ownedItem.findFirst({
    where: {
      userProfileId: profileId,
      globalItemId: item.globalItemId,
      positionX: item.positionX,
      positionY: item.positionY,
      roomIndex: item.roomIndex,
    },
    orderBy: [{ updatedAt: 'desc' }, { serverId: 'desc' }],
    select: { id: true, serverId: true },
  });
  if (twin) {
    await tx.ownedItem.update({
      where: { id: twin.id },
      data: ownedItemWriteData({ ...item, serverId: twin.serverId }),
    });
    return;
  }

  await tx.ownedItem.upsert({
    where: { userProfileId_serverId: { userProfileId: profileId, serverId: item.serverId } },
    update: ownedItemWriteData(item),
    create: {
      id: ownedItemKey(networkUid, item.serverId),
      userProfileId: profileId,
      ...ownedItemWriteData(item),
    },
  });
}

function starterSeeds(): OwnedItemSeed[] {
  return [...STARTER_BUILDING_ITEMS, ...STARTER_RESTAURANT_ITEMS];
}

function seedOwnedItems(networkUid: string, seeds: readonly OwnedItemSeed[]) {
  return seeds.map((item, index) => {
    const serverId = -(index + 1);
    return {
      id: ownedItemKey(networkUid, serverId),
      serverId,
      globalItemId: item.id,
      positionX: item.x,
      positionY: item.y,
      data: item.data ?? 0,
      roomIndex: item.roomIndex ?? 0,
      employeeNetwork: 0,
      employeeNetworkUid: '',
      employeePlayfishUid: 0,
    };
  });
}

function seedStarterRecipes(networkUid: string) {
  return STARTER_RECIPES.map((recipe) => ({
    id: inventoryKey(networkUid, recipe.id),
    globalItemId: recipe.id,
    number: recipe.level,
    isSelected: recipe.selected,
  }));
}

function seedStarterIngredients(networkUid: string) {
  return STARTER_INGREDIENTS.map((ingredient) => ({
    id: ingredientKey(networkUid, ingredient.id),
    globalItemId: ingredient.id,
    number: ingredient.count,
    isLocked: false,
  }));
}

function seedStarterFloors(networkUid: string) {
  return STARTER_FLOOR_INDEXES.map((floorIndex) => ({
    id: floorKey(networkUid, floorIndex),
    floorIndex,
    tilesJson: JSON.stringify(defaultFloorTiles()),
  }));
}

async function ensureStarterFloors(networkUid: string): Promise<void> {
  const profileId = profileKey(networkUid);
  for (const floor of seedStarterFloors(networkUid)) {
    await prisma.restaurantFloor.upsert({
      where: { userProfileId_floorIndex: { userProfileId: profileId, floorIndex: floor.floorIndex } },
      update: {},
      create: {
        ...floor,
        userProfileId: profileId,
      },
    });
  }
}

async function repairProfileState(networkUid: string, profile: StoredProfile, seedStarterItems: boolean): Promise<boolean> {
  let repaired = false;
  await prisma.$transaction(async (tx) => {
    repaired = await repairProfileStateInTransaction(tx, networkUid, profileKey(networkUid), seedStarterItems, profile);
  });
  return repaired;
}

export async function repairProfileStateInTransaction(
  tx: any,
  networkUid: string,
  profileId: string,
  seedStarterItems: boolean,
  loadedProfile?: StoredProfile,
): Promise<boolean> {
  const removedEmptyIngredients = await tx.ingredientInventory.deleteMany({
    where: { userProfileId: profileId, number: { lte: 0 } },
  });
  const floors = loadedProfile?.floors ?? await tx.restaurantFloor.findMany({ where: { userProfileId: profileId } });
  const gardenPlots = loadedProfile?.gardenPlots ?? await tx.gardenPlot.findMany({ where: { userProfileId: profileId } });
  const profileLevel = loadedProfile?.userLevel
    ?? (await tx.userProfile.findUnique({ where: { id: profileId }, select: { userLevel: true } }))?.userLevel
    ?? 1;
  let repaired = removedEmptyIngredients.count > 0;
  if (seedStarterItems) {
    // Learned recipes are permanent, so an empty menu means this profile predates
    // food seeding (or was created before starter food existed). Backfill the
    // original starter menu, ingredients, and demand without ever re-granting to a
    // played account.
    const inventoryItems = loadedProfile?.inventoryItems
      ?? await tx.inventoryItem.findMany({ where: { userProfileId: profileId } });
    if (inventoryItems.length === 0) {
      for (const recipe of seedStarterRecipes(networkUid)) {
        await tx.inventoryItem.create({ data: { ...recipe, userProfileId: profileId } });
      }

      const ingredients = loadedProfile?.ingredients
        ?? await tx.ingredientInventory.findMany({ where: { userProfileId: profileId } });
      if (ingredients.length === 0) {
        for (const ingredient of seedStarterIngredients(networkUid)) {
          await tx.ingredientInventory.create({ data: { ...ingredient, userProfileId: profileId } });
        }
      }

      const demand = loadedProfile?.demandPoint
        ?? (await tx.userProfile.findUnique({ where: { id: profileId }, select: { demandPoint: true } }))?.demandPoint
        ?? 0;
      if (demand === 0) {
        await tx.userProfile.update({
          where: { id: profileId },
          data: { demandPoint: DEFAULT_NEW_PLAYER_DEMAND },
        });
      }

      repaired = true;
    }
  }

  for (const floorIndex of STARTER_FLOOR_INDEXES) {
    const existingFloor = floors.find((floor: RestaurantFloor) => floor.floorIndex === floorIndex);
    const tilesJson = JSON.stringify(defaultFloorTiles());

    if (!existingFloor) {
      await tx.restaurantFloor.create({
        data: {
          id: floorKey(networkUid, floorIndex),
          userProfileId: profileId,
          floorIndex,
          tilesJson,
        },
      });
      repaired = true;
    } else if (!hasValidFloorTiles(existingFloor.tilesJson)) {
      await tx.restaurantFloor.update({
        where: { userProfileId_floorIndex: { userProfileId: profileId, floorIndex } },
        data: { tilesJson },
      });
      repaired = true;
    }
  }

  const unlockedPlotCount = gardenPlotCountForLevel(profileLevel);
  for (let plotId = 0; plotId < unlockedPlotCount; plotId++) {
    if (gardenPlots.some((plot: GardenPlot) => plot.plotId === plotId)) {
      continue;
    }

    await tx.gardenPlot.create({
      data: {
        id: gardenPlotKey(networkUid, plotId),
        userProfileId: profileId,
        plotId,
        ingredientId: 0,
        plantWetTime: 0,
        timeToDry: 0,
      },
    });
    repaired = true;
  }

  return repaired;
}

function defaultFloorTiles(): number[] {
  return Array.from({ length: FLOOR_TILE_COUNT }, () => 0);
}

function hasValidFloorTiles(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === FLOOR_TILE_COUNT;
  } catch {
    return false;
  }
}

function itemType(globalItemId: number): number {
  return Math.floor(globalItemId / 1000000);
}

function needsProfileRepair(profile: StoredProfile): boolean {
  return (
    !Number.isInteger(profile.userLevel) ||
    profile.userLevel < 1 ||
    profile.userLevel > 99 ||
    !Number.isInteger(profile.activeFloorIndex) ||
    profile.activeFloorIndex < 0 ||
    profile.activeFloorIndex > 8
  );
}

function boundedIntOrFallback(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    return Math.min(max, Math.max(min, Number.isInteger(fallback) ? fallback : min));
  }

  return value;
}

function gardenPlotCountForLevel(level: number): number {
  if (!Number.isInteger(level) || level <= 0) {
    return 0;
  }

  if (level >= GARDEN_PLOTS_BY_LEVEL.length) {
    return 9;
  }

  return GARDEN_PLOTS_BY_LEVEL[level] ?? 0;
}

function employeeWorkTime(employee: EmployeeData): number {
  return boundedIntOrFallback(employee.happiness, EMPLOYEE_MAX_WORK_TIME_MS, 0, EMPLOYEE_MAX_WORK_TIME_MS);
}

async function changeInventoryItem(
  tx: any,
  profileId: string,
  networkUid: string,
  change: InventoryItemData,
): Promise<void> {
  const existing = await tx.inventoryItem.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: change.globalItemId } },
  });
  const changedNumber = Math.max(0, (existing?.number ?? 0) + change.delta);
  // Selecting a recipe is also proof that the recipe is owned. The shipped
  // client sends delta=0 for selection, so a newly selected recipe starts at
  // level 1 instead of an unusable level 0.
  const nextNumber = change.selected === undefined ? changedNumber : Math.max(1, changedNumber);

  if (nextNumber === 0 && !change.selected) {
    await tx.inventoryItem.deleteMany({ where: { userProfileId: profileId, globalItemId: change.globalItemId } });
    return;
  }

  await tx.inventoryItem.upsert({
    where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: change.globalItemId } },
    update: {
      number: nextNumber,
      ...(change.selected === undefined ? {} : { isSelected: change.selected }),
    },
    create: {
      id: inventoryKey(networkUid, change.globalItemId),
      userProfileId: profileId,
      globalItemId: change.globalItemId,
      number: nextNumber,
      isSelected: Boolean(change.selected),
    },
  });
}

async function applyOrderedSaveMutations(
  tx: Prisma.TransactionClient,
  profileId: string,
  networkUid: string,
  mutations: readonly SaveMutation[],
): Promise<void> {
  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'removeOwned':
        await tx.ownedItem.deleteMany({ where: { userProfileId: profileId, serverId: mutation.serverId } });
        break;
      case 'upsertOwned':
        await upsertOwnedItemReconciled(tx, profileId, networkUid, mutation.item);
        break;
      case 'inventory':
        await changeInventoryItem(tx, profileId, networkUid, mutation.change);
        break;
      case 'bulkInventory':
        await moveInGameItemsToInventory(tx, profileId, networkUid, mutation.move);
        break;
      case 'floor':
        await upsertRestaurantFloor(tx, profileId, networkUid, mutation.floor);
        break;
    }
  }
}

async function upsertRestaurantFloor(
  tx: Prisma.TransactionClient,
  profileId: string,
  networkUid: string,
  floor: FloorData,
): Promise<void> {
  await tx.restaurantFloor.upsert({
    where: { userProfileId_floorIndex: { userProfileId: profileId, floorIndex: floor.floorIndex } },
    update: { tilesJson: JSON.stringify(floor.tiles) },
    create: {
      id: floorKey(networkUid, floor.floorIndex),
      userProfileId: profileId,
      floorIndex: floor.floorIndex,
      tilesJson: JSON.stringify(floor.tiles),
    },
  });
}

async function moveInGameItemsToInventory(
  tx: any,
  profileId: string,
  networkUid: string,
  move: BulkInventoryMoveData,
): Promise<void> {
  const ownedItems = await tx.ownedItem.findMany({
    where: {
      userProfileId: profileId,
      roomIndex: move.floorIndex,
    },
  });

  for (const item of ownedItems.filter((owned: OwnedItem) => (
    itemType(owned.globalItemId) === move.itemTypeId
    && !isNonEditableRestaurantEntitlementItem(owned.globalItemId)
  ))) {
    await changeInventoryItem(tx, profileId, networkUid, { globalItemId: item.globalItemId, delta: 1 });
    await tx.ownedItem.deleteMany({ where: { userProfileId: profileId, serverId: item.serverId } });
  }

  if (move.itemTypeId !== 3) {
    return;
  }

  const floor = await tx.restaurantFloor.findUnique({
    where: { userProfileId_floorIndex: { userProfileId: profileId, floorIndex: move.floorIndex } },
  });

  if (!floor) {
    return;
  }

  for (const tileItemId of readStoredFloorTiles(floor.tilesJson)) {
    if (tileItemId !== 0) {
      await changeInventoryItem(tx, profileId, networkUid, { globalItemId: tileItemId, delta: 1 });
    }
  }
}

async function ensureFloorTileInventoryCounts(tx: any, profileId: string, networkUid: string): Promise<void> {
  const floors = await tx.restaurantFloor.findMany({ where: { userProfileId: profileId } });
  const requiredCounts = new Map<number, number>();

  for (const floor of floors) {
    for (const tileItemId of readStoredFloorTiles(floor.tilesJson)) {
      if (tileItemId !== 0) {
        requiredCounts.set(tileItemId, (requiredCounts.get(tileItemId) ?? 0) + 1);
      }
    }
  }

  for (const [globalItemId, requiredCount] of requiredCounts) {
    const existing = await tx.inventoryItem.findUnique({
      where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId } },
    });

    if ((existing?.number ?? 0) >= requiredCount) {
      continue;
    }

    await tx.inventoryItem.upsert({
      where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId } },
      update: { number: requiredCount },
      create: {
        id: inventoryKey(networkUid, globalItemId),
        userProfileId: profileId,
        globalItemId,
        number: requiredCount,
        isSelected: false,
      },
    });
  }
}

function readStoredFloorTiles(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

async function changeIngredient(
  tx: any,
  profileId: string,
  networkUid: string,
  change: IngredientChangeData,
): Promise<void> {
  const existing = await tx.ingredientInventory.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: change.globalItemId } },
  });
  const nextNumber = Math.max(0, (existing?.number ?? 0) + change.delta);

  if (nextNumber === 0) {
    await tx.ingredientInventory.deleteMany({ where: { userProfileId: profileId, globalItemId: change.globalItemId } });
    return;
  }

  await tx.ingredientInventory.upsert({
    where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: change.globalItemId } },
    // Ingredients the client reports receiving (positive delta — harvest, quiz,
    // market/cash purchase, first-visit gift…) start locked so they cannot be
    // traded away until the owner unlocks them. Consuming leaves the lock alone.
    update: { number: nextNumber, ...(change.delta > 0 ? { isLocked: true } : {}) },
    create: {
      id: ingredientKey(networkUid, change.globalItemId),
      userProfileId: profileId,
      globalItemId: change.globalItemId,
      number: nextNumber,
      isLocked: true,
    },
  });
}

async function applyGardenChange(
  tx: any,
  profileId: string,
  networkUid: string,
  playerLevel: number,
  change: GardenChangeData,
): Promise<void> {
  if (change.action === 'harvest') {
    const existing = await tx.gardenPlot.findUnique({
      where: { userProfileId_plotId: { userProfileId: profileId, plotId: change.plotId } },
    });
    if (existing) {
      await changeIngredient(tx, profileId, networkUid, { globalItemId: existing.ingredientId, delta: 1 });
      await tx.gardenPlot.deleteMany({ where: { userProfileId: profileId, plotId: change.plotId } });
    }
    return;
  }

  if (change.action === 'water') {
    const existing = await tx.gardenPlot.findUnique({
      where: { userProfileId_plotId: { userProfileId: profileId, plotId: change.plotId } },
    });
    if (existing) {
      await tx.gardenPlot.update({
        where: { userProfileId_plotId: { userProfileId: profileId, plotId: change.plotId } },
        data: { timeToDry: nextWaterLevel(existing.timeToDry, existing.updatedAt) },
      });
    }
    return;
  }

  const ingredientId = gardenIngredientForSeed(playerLevel);
  await tx.gardenPlot.upsert({
    where: { userProfileId_plotId: { userProfileId: profileId, plotId: change.plotId } },
    update: {
      ingredientId,
      plantWetTime: 0,
      timeToDry: GARDEN_WETNESS_PER_WATER_SECONDS,
    },
    create: {
      id: gardenPlotKey(networkUid, change.plotId),
      userProfileId: profileId,
      plotId: change.plotId,
      ingredientId,
      plantWetTime: 0,
      timeToDry: GARDEN_WETNESS_PER_WATER_SECONDS,
    },
  });
}

function nextWaterLevel(currentWetness: number, wateredAt: Date): number {
  const elapsed = Math.max(0, Math.floor((Date.now() - wateredAt.getTime()) / 1000));
  const remainingWetness = Math.max(0, Math.min(currentWetness, GARDEN_MAX_WETNESS_SECONDS) - elapsed);
  return Math.min(GARDEN_MAX_WETNESS_SECONDS, remainingWetness + GARDEN_WETNESS_PER_WATER_SECONDS);
}

function defaultVisitIngredient(seed: string): number {
  const numeric = Number.parseInt(seed, 10);
  const offset = Number.isFinite(numeric) ? Math.abs(numeric) % 3 : 0;
  return 4000000 + offset;
}

async function createSeedProfile(seed: FriendProfileSeed): Promise<void> {
  await prisma.userProfile.create({
    data: {
      id: profileKey(seed.networkUid),
      network: FACEBOOK_NETWORK,
      networkUid: seed.networkUid,
      playfishUid: seed.playfishUid,
      firstName: seed.firstName,
      fullName: seed.fullName,
      restaurantName: seed.restaurantName,
      gender: seed.gender,
      credits: seed.credits,
      playCount: seed.playCount,
      userLevel: seed.userLevel,
      gourmetPoint: seed.gourmetPoint,
      trashPoint: seed.trashPoint,
      demandPoint: seed.demandPoint,
      musicPlay: seed.musicPlay,
      ownedItems: {
        create: seedOwnedItems(seed.networkUid, seed.ownedItems),
      },
    },
  });
}

function profileKey(networkUid: string): string {
  return `facebook:${networkUid || PLAYER_NETWORK_UID}`;
}

function ownedItemKey(networkUid: string, serverId: number): string {
  return `${profileKey(networkUid)}:owned:${serverId}`;
}

function inventoryKey(networkUid: string, globalItemId: number): string {
  return `${profileKey(networkUid)}:inventory:${globalItemId}`;
}

function ingredientKey(networkUid: string, globalItemId: number): string {
  return `${profileKey(networkUid)}:ingredient:${globalItemId}`;
}

function gardenPlotKey(networkUid: string, plotId: number): string {
  return `${profileKey(networkUid)}:garden:${plotId}`;
}

function floorKey(networkUid: string, floorIndex: number): string {
  return `${profileKey(networkUid)}:floor:${floorIndex}`;
}

function employeeKey(networkUid: string, employeeNetworkUid: string): string {
  return `${profileKey(networkUid)}:employee:${employeeNetworkUid}`;
}

function visitKey(networkUid: string, friendNetworkUid: string): string {
  return `${profileKey(networkUid)}:visit:${friendNetworkUid}`;
}
