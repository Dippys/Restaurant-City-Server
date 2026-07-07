import type { OwnedItem, UserProfile } from '@prisma/client';
import { prisma } from './client';
import { FACEBOOK_NETWORK, ITEM_CATALOG, PLAYER_NETWORK_UID, defaultProfileName, isKnownItemId } from './defaults';
import { ensureStarterFriends } from './profile-store';

export type AdminUser = UserProfile & { ownedItems: OwnedItem[] };

export interface ProfileInput {
  readonly networkUid: string;
  readonly firstName: string;
  readonly fullName: string;
  readonly restaurantName: string;
  readonly gender: number;
  readonly credits: number;
  readonly userLevel: number;
  readonly gourmetPoint: number;
  readonly trashPoint: number;
  readonly demandPoint: number;
  readonly musicPlay: number;
  readonly activeFloorIndex: number;
  readonly isInStreet: boolean;
}

export interface OwnedItemInput {
  readonly globalItemId: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly data: number;
  readonly roomIndex: number;
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  await ensureStarterFriends();

  return prisma.userProfile.findMany({
    include: { ownedItems: { orderBy: { serverId: 'asc' } } },
    orderBy: { networkUid: 'asc' },
  });
}

export function itemCatalog() {
  return ITEM_CATALOG;
}

export async function createAdminUser(input: ProfileInput): Promise<AdminUser> {
  const clean = validateProfileInput(input, true);
  const id = profileKey(clean.networkUid);
  const { firstName, fullName } = clean.firstName ? clean : defaultProfileName(clean.networkUid);
  const playfishUid = Number.parseInt(clean.networkUid, 10);

  await prisma.userProfile.create({
    data: {
      id,
      network: FACEBOOK_NETWORK,
      networkUid: clean.networkUid,
      playfishUid: Number.isFinite(playfishUid) ? playfishUid : 0,
      firstName,
      fullName,
      restaurantName: clean.restaurantName,
      gender: clean.gender,
      credits: clean.credits,
      userLevel: clean.userLevel,
      gourmetPoint: clean.gourmetPoint,
      trashPoint: clean.trashPoint,
      demandPoint: clean.demandPoint,
      musicPlay: clean.musicPlay,
      activeFloorIndex: clean.activeFloorIndex,
      isInStreet: clean.isInStreet,
    },
  });

  return getAdminUser(clean.networkUid);
}

export async function updateAdminUser(networkUid: string, input: ProfileInput): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const clean = validateProfileInput({ ...input, networkUid: safeNetworkUid }, false);

  await prisma.userProfile.update({
    where: { id: profileKey(safeNetworkUid) },
    data: {
      firstName: clean.firstName,
      fullName: clean.fullName,
      restaurantName: clean.restaurantName,
      gender: clean.gender,
      credits: clean.credits,
      userLevel: clean.userLevel,
      gourmetPoint: clean.gourmetPoint,
      trashPoint: clean.trashPoint,
      demandPoint: clean.demandPoint,
      musicPlay: clean.musicPlay,
      activeFloorIndex: clean.activeFloorIndex,
      isInStreet: clean.isInStreet,
    },
  });

  return getAdminUser(safeNetworkUid);
}

export async function deleteAdminUser(networkUid: string): Promise<void> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  await prisma.userProfile.deleteMany({ where: { id: profileKey(safeNetworkUid) } });
}

export async function resetAdminDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.ownedItem.deleteMany(),
    prisma.userProfile.deleteMany(),
  ]);
}

export async function addAdminOwnedItem(networkUid: string, input: OwnedItemInput): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const user = await getAdminUser(safeNetworkUid);
  const item = validateOwnedItemInput(input);
  const minServerId = user.ownedItems.reduce((min, owned) => Math.min(min, owned.serverId), 0);
  const serverId = minServerId - 1;

  await prisma.ownedItem.create({
    data: {
      id: ownedItemKey(safeNetworkUid, serverId),
      userProfileId: profileKey(safeNetworkUid),
      serverId,
      ...item,
      employeeNetwork: 0,
      employeeNetworkUid: '',
      employeePlayfishUid: 0,
    },
  });

  return getAdminUser(safeNetworkUid);
}

export async function updateAdminOwnedItem(
  networkUid: string,
  serverId: number,
  input: OwnedItemInput,
): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safeServerId = boundedInt(serverId, 'serverId', -2147483648, 2147483647);
  const item = validateOwnedItemInput(input);

  await prisma.ownedItem.update({
    where: { userProfileId_serverId: { userProfileId: profileKey(safeNetworkUid), serverId: safeServerId } },
    data: item,
  });

  return getAdminUser(safeNetworkUid);
}

export async function deleteAdminOwnedItem(networkUid: string, serverId: number): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safeServerId = boundedInt(serverId, 'serverId', -2147483648, 2147483647);

  await prisma.ownedItem.deleteMany({
    where: { userProfileId: profileKey(safeNetworkUid), serverId: safeServerId },
  });

  return getAdminUser(safeNetworkUid);
}

async function getAdminUser(networkUid: string): Promise<AdminUser> {
  return prisma.userProfile.findUniqueOrThrow({
    where: { id: profileKey(networkUid) },
    include: { ownedItems: { orderBy: { serverId: 'asc' } } },
  });
}

function validateProfileInput(input: ProfileInput, creating: boolean): ProfileInput {
  const networkUid = validateNetworkUid(input.networkUid);

  return {
    networkUid,
    firstName: cleanText(input.firstName || (creating ? defaultProfileName(networkUid).firstName : ''), 'firstName', 1, 32),
    fullName: cleanText(input.fullName || (creating ? defaultProfileName(networkUid).fullName : ''), 'fullName', 1, 64),
    restaurantName: cleanText(input.restaurantName || 'My Restaurant', 'restaurantName', 1, 48),
    gender: boundedInt(input.gender, 'gender', 0, 1),
    credits: boundedInt(input.credits, 'credits', 0, 999999999),
    userLevel: boundedInt(input.userLevel, 'userLevel', 1, 99),
    gourmetPoint: boundedInt(input.gourmetPoint, 'gourmetPoint', 0, 999999999),
    trashPoint: boundedInt(input.trashPoint, 'trashPoint', 0, 999999999),
    demandPoint: boundedInt(input.demandPoint, 'demandPoint', 0, 999999999),
    musicPlay: boundedInt(input.musicPlay, 'musicPlay', 0, 999999999),
    activeFloorIndex: boundedInt(input.activeFloorIndex, 'activeFloorIndex', 0, 8),
    isInStreet: Boolean(input.isInStreet),
  };
}

function validateOwnedItemInput(input: OwnedItemInput): OwnedItemInput {
  const globalItemId = boundedInt(input.globalItemId, 'globalItemId', 1, 9999999);
  if (!isKnownItemId(globalItemId)) {
    throw new Error('Choose an item from the catalog.');
  }

  return {
    globalItemId,
    positionX: boundedInt(input.positionX, 'positionX', -1000, 1000),
    positionY: boundedInt(input.positionY, 'positionY', -1000, 1000),
    data: boundedInt(input.data, 'data', 0, 255),
    roomIndex: boundedInt(input.roomIndex, 'roomIndex', 0, 8),
  };
}

function validateNetworkUid(value: string): string {
  const networkUid = String(value ?? '').trim();
  if (!/^\d{1,18}$/.test(networkUid)) {
    throw new Error('User id must be 1 to 18 digits.');
  }
  return networkUid;
}

function cleanText(value: string, field: string, minLength: number, maxLength: number): string {
  const clean = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (clean.length < minLength || clean.length > maxLength) {
    throw new Error(`${field} must be ${minLength}-${maxLength} characters.`);
  }
  if (!/^[\w .'-]+$/u.test(clean)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return clean;
}

function boundedInt(value: number, field: string, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}.`);
  }
  return numberValue;
}

function profileKey(networkUid: string): string {
  return `facebook:${networkUid || PLAYER_NETWORK_UID}`;
}

function ownedItemKey(networkUid: string, serverId: number): string {
  return `${profileKey(networkUid)}:owned:${serverId}`;
}
