import type { Employee, FriendVisit, GardenPlot, IngredientInventory, InventoryItem, OwnedItem, RestaurantFloor, UserProfile } from '@prisma/client';
import { prisma } from './client';
import {
  FACEBOOK_NETWORK,
  PLAYER_NETWORK_UID,
  STARTER_FRIENDS,
  STARTER_BUILDING_ITEMS,
  STARTER_RESTAURANT_ITEMS,
  type FriendProfileSeed,
  type OwnedItemSeed,
  defaultProfileName,
} from './defaults';
import type { ActiveAccount } from '../session';

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
  readonly ingredientChanges: readonly IngredientChangeData[];
  readonly lockIngredientChanges: readonly IngredientLockData[];
  readonly gardenChanges: readonly GardenChangeData[];
  readonly floorChanges: readonly FloorData[];
  readonly employeeChanges: readonly EmployeeData[];
  readonly openMailIds: readonly number[];
  readonly deleteMailIds: readonly number[];
  readonly visitedFriends: readonly NetworkUidData[];
}

export interface InventoryItemData {
  readonly globalItemId: number;
  readonly delta: number;
  readonly selected?: boolean;
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
  readonly ingredientId?: number;
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

export function playerNetworkUid(): string {
  return PLAYER_NETWORK_UID;
}

export async function getPlayerProfile(account?: ActiveAccount): Promise<StoredProfile> {
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

export async function getAllFriends(activeNetworkUid = PLAYER_NETWORK_UID): Promise<StoredProfile[]> {
  await ensureStarterFriends();

  return prisma.userProfile.findMany({
    where: {
      networkUid: { in: STARTER_FRIENDS.map((friend) => friend.networkUid) },
      NOT: { networkUid: activeNetworkUid },
    },
    include: profileInclude,
    orderBy: { networkUid: 'asc' },
  });
}

export async function ensureLoginAccount(account: ActiveAccount): Promise<StoredProfile> {
  await ensureStarterFriends();
  return getPlayerProfile(account);
}

export async function ensureStarterFriends(): Promise<void> {
  for (const friend of STARTER_FRIENDS) {
    const existing = await prisma.userProfile.findUnique({
      where: { id: profileKey(friend.networkUid) },
      include: profileInclude,
    });

    if (!existing) {
      await createSeedProfile(friend);
      continue;
    }

    if (existing.ownedItems.length === 0) {
      await prisma.ownedItem.createMany({
        data: seedOwnedItems(friend.networkUid, friend.ownedItems).map((item) => ({
          ...item,
          userProfileId: profileKey(friend.networkUid),
        })),
      });
    }
  }
}

export async function savePlayerProfile(profile: SavedProfileData, audit: SaveAuditData): Promise<number> {
  const profileId = profileKey(profile.id.networkUid);
  const current = await ensureProfile(profile.id.networkUid || PLAYER_NETWORK_UID);
  const nextCredits = audit.newCredits ?? current.credits + audit.creditDelta;
  const saneUserLevel = boundedIntOrFallback(profile.userLevel, current.userLevel, 1, 99);
  const saneActiveFloorIndex = boundedIntOrFallback(profile.activeFloorIndex, current.activeFloorIndex, 0, 8);

  await prisma.$transaction(async (tx) => {
    await tx.userProfile.update({
      where: { id: profileId },
      data: {
        network: profile.id.network,
        networkUid: profile.id.networkUid || PLAYER_NETWORK_UID,
        playfishUid: profile.id.playfishUid,
        restaurantName: profile.restaurantName,
        gourmetPoint: profile.gourmetPoint,
        trashPoint: profile.trashPoint,
        demandPoint: profile.demandPoint,
        musicPlay: profile.musicPlay,
        isInStreet: profile.isInStreet,
        awards: profile.awards ? new Uint8Array(profile.awards) : null,
        userLevel: saneUserLevel,
        activeFloorIndex: saneActiveFloorIndex,
        credits: nextCredits,
        saveVersion: audit.saveVersion + 1,
        lastSave: Math.floor(Date.now() / 1000),
      },
    });

    for (const serverId of audit.removeOwnedItemIds) {
      await tx.ownedItem.deleteMany({ where: { userProfileId: profileId, serverId } });
    }

    for (const item of audit.upsertOwnedItems) {
      await tx.ownedItem.upsert({
        where: { userProfileId_serverId: { userProfileId: profileId, serverId: item.serverId } },
        update: ownedItemWriteData(item),
        create: {
          id: ownedItemKey(profile.id.networkUid, item.serverId),
          userProfileId: profileId,
          ...ownedItemWriteData(item),
        },
      });
    }

    for (const change of audit.inventoryChanges) {
      await changeInventoryItem(tx, profileId, profile.id.networkUid, change);
    }

    for (const change of audit.ingredientChanges) {
      await changeIngredient(tx, profileId, profile.id.networkUid, change);
    }

    for (const change of audit.lockIngredientChanges) {
      await tx.ingredientInventory.upsert({
        where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: change.globalItemId } },
        update: { isLocked: change.isLocked },
        create: {
          id: ingredientKey(profile.id.networkUid, change.globalItemId),
          userProfileId: profileId,
          globalItemId: change.globalItemId,
          number: 0,
          isLocked: change.isLocked,
        },
      });
    }

    for (const change of audit.gardenChanges) {
      await applyGardenChange(tx, profileId, profile.id.networkUid, change);
    }

    for (const floor of audit.floorChanges) {
      await tx.restaurantFloor.upsert({
        where: { userProfileId_floorIndex: { userProfileId: profileId, floorIndex: floor.floorIndex } },
        update: { tilesJson: JSON.stringify(floor.tiles) },
        create: {
          id: floorKey(profile.id.networkUid, floor.floorIndex),
          userProfileId: profileId,
          floorIndex: floor.floorIndex,
          tilesJson: JSON.stringify(floor.tiles),
        },
      });
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
          happiness: employee.happiness,
          task: employee.task,
          notify: employee.notify,
        },
        create: {
          id: employeeKey(profile.id.networkUid, employeeNetworkUid),
          userProfileId: profileId,
          network: employee.id.network,
          networkUid: employeeNetworkUid,
          playfishUid: employee.id.playfishUid,
          happiness: employee.happiness,
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
  });

  return audit.saveVersion;
}

interface EnsureProfileOptions {
  readonly firstName?: string;
  readonly fullName?: string;
  readonly restaurantName?: string;
  readonly playfishUid?: number;
  readonly seedStarterItems?: boolean;
}

async function ensureProfile(networkUid: string, options: EnsureProfileOptions = {}): Promise<StoredProfile> {
  const safeNetworkUid = networkUid || PLAYER_NETWORK_UID;
  const id = profileKey(safeNetworkUid);
  const existing = await prisma.userProfile.findUnique({
    where: { id },
    include: profileInclude,
  });

  if (existing) {
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

    if (shouldSeedStarterItems(existing, Boolean(options.seedStarterItems))) {
      await prisma.ownedItem.createMany({
        data: seedOwnedItems(safeNetworkUid, starterSeeds()).map((item) => ({
          ...item,
          userProfileId: id,
        })),
      });

      return prisma.userProfile.findUniqueOrThrow({
        where: { id },
        include: profileInclude,
      });
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
      userLevel: 1,
      gourmetPoint: 0,
      trashPoint: 0,
      demandPoint: 0,
      musicPlay: 0,
      ownedItems: {
        create: options.seedStarterItems ? seedOwnedItems(safeNetworkUid, starterSeeds()) : [],
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

function shouldSeedStarterItems(profile: StoredProfile, seedStarterItems: boolean): boolean {
  return (
    seedStarterItems &&
    profile.ownedItems.length === 0 &&
    profile.userLevel === 1 &&
    profile.credits === 0 &&
    profile.gourmetPoint === 0
  );
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

async function changeInventoryItem(
  tx: any,
  profileId: string,
  networkUid: string,
  change: InventoryItemData,
): Promise<void> {
  const existing = await tx.inventoryItem.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: change.globalItemId } },
  });
  const nextNumber = Math.max(0, (existing?.number ?? 0) + change.delta);

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

  if (nextNumber === 0 && !existing?.isLocked) {
    await tx.ingredientInventory.deleteMany({ where: { userProfileId: profileId, globalItemId: change.globalItemId } });
    return;
  }

  await tx.ingredientInventory.upsert({
    where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: change.globalItemId } },
    update: { number: nextNumber },
    create: {
      id: ingredientKey(networkUid, change.globalItemId),
      userProfileId: profileId,
      globalItemId: change.globalItemId,
      number: nextNumber,
      isLocked: false,
    },
  });
}

async function applyGardenChange(
  tx: any,
  profileId: string,
  networkUid: string,
  change: GardenChangeData,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

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
    await tx.gardenPlot.updateMany({
      where: { userProfileId: profileId, plotId: change.plotId },
      data: { plantWetTime: now },
    });
    return;
  }

  const ingredientId = change.ingredientId ?? defaultVisitIngredient(String(change.plotId));
  await tx.gardenPlot.upsert({
    where: { userProfileId_plotId: { userProfileId: profileId, plotId: change.plotId } },
    update: {
      ingredientId,
      plantWetTime: now,
      timeToDry: 86400,
    },
    create: {
      id: gardenPlotKey(networkUid, change.plotId),
      userProfileId: profileId,
      plotId: change.plotId,
      ingredientId,
      plantWetTime: now,
      timeToDry: 86400,
    },
  });
  await changeIngredient(tx, profileId, networkUid, { globalItemId: ingredientId, delta: -1 });
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
