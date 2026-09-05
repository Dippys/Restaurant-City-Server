import type { Prisma } from '@prisma/client';
import { prisma } from './client';
import {
  DEFAULT_NEW_PLAYER_DEMAND,
  FACEBOOK_NETWORK,
  PLAYER_NETWORK_UID,
  SYSTEM_NETWORK_UID,
  STARTER_BUILDING_ITEMS,
  STARTER_INGREDIENTS,
  STARTER_RECIPES,
  STARTER_RESTAURANT_ITEMS,
  defaultProfileName,
  type OwnedItemSeed,
} from './defaults';
import { ensureEconomyCatalog } from './rpc-store';
import { ensureStarterFriends } from './profile-store';
import { fullCatalog, isCatalogItemId, isEmployeeSnackItem, isFoodKingEligibleItem, isGiftableItemId } from './item-catalog';
import { grantMailItem } from './system-mail';
import { enqueueLiveMail } from '../live-events';
import { queryBatches } from './query-batches';

const adminUserInclude = {
  ownedItems: { orderBy: { serverId: 'asc' as const } },
  inventoryItems: { orderBy: { globalItemId: 'asc' as const } },
  ingredients: { orderBy: { globalItemId: 'asc' as const } },
  gardenPlots: { orderBy: { plotId: 'asc' as const } },
  floors: { orderBy: { floorIndex: 'asc' as const } },
  employees: { orderBy: { networkUid: 'asc' as const } },
  mailsSent: { orderBy: { sendDate: 'desc' as const } },
  mailsReceived: { orderBy: { sendDate: 'desc' as const } },
  visits: { orderBy: { lastVisitedAt: 'desc' as const } },
  visitCredits: { orderBy: { creditedAt: 'desc' as const } },
  rankingsGiven: { orderBy: { updatedAt: 'desc' as const } },
  rankingsReceived: { orderBy: { updatedAt: 'desc' as const } },
  gameEvents: { orderBy: { createdAt: 'desc' as const }, take: 100 },
  storedImages: {
    select: {
      id: true,
      userProfileId: true,
      imageType: true,
      width: true,
      height: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' as const },
  },
  notificationsSent: { orderBy: { createdAtUnix: 'desc' as const } },
  notificationsReceived: { orderBy: { createdAtUnix: 'desc' as const } },
  cashTransactions: { orderBy: { createdAtUnix: 'desc' as const }, take: 100 },
} satisfies Prisma.UserProfileInclude;

export type AdminUser = Prisma.UserProfileGetPayload<{ include: typeof adminUserInclude }>;

const adminUserSummarySelect = {
  id: true, network: true, networkUid: true, playfishUid: true,
  firstName: true, fullName: true, restaurantName: true,
  gender: true, credits: true, cashBalance: true, playCount: true,
  userLevel: true, gourmetPoint: true, lastSave: true, updatedAt: true,
} satisfies Prisma.UserProfileSelect;

export type AdminUserSummary = Prisma.UserProfileGetPayload<{ select: typeof adminUserSummarySelect }>;

export interface AdminUserPage {
  readonly users: AdminUserSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface AdminUserOption {
  readonly networkUid: string;
  readonly firstName: string;
  readonly fullName: string;
}

export interface ProfileInput {
  readonly networkUid: string;
  readonly playfishUid?: number;
  readonly firstName: string;
  readonly fullName: string;
  readonly restaurantName: string;
  readonly imageUrl?: string;
  readonly largeImageUrl?: string;
  readonly gender: number;
  readonly credits: number;
  readonly cashBalance?: number;
  readonly playCount?: number;
  readonly userLevel: number;
  readonly gourmetPoint: number;
  readonly nbVote?: number;
  readonly totalMark?: number;
  readonly trashPoint: number;
  readonly demandPoint: number;
  readonly musicPlay: number;
  readonly bookmarkCount?: number;
  readonly activeFloorIndex: number;
  readonly isInStreet: boolean;
  readonly saveVersion?: number;
  readonly lastSave?: number;
  readonly lastSurveyTime?: number;
  readonly consecutionCount?: number;
}

export interface OwnedItemInput {
  readonly globalItemId: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly data: number;
  readonly roomIndex: number;
  readonly employeeNetwork?: number;
  readonly employeeNetworkUid?: string;
  readonly employeePlayfishUid?: number;
}

export interface InventoryInput {
  readonly globalItemId: number;
  readonly number: number;
  readonly isSelected?: boolean;
}

export interface IngredientInput {
  readonly globalItemId: number;
  readonly number: number;
  readonly isLocked?: boolean;
}

export interface GardenPlotInput {
  readonly plotId: number;
  readonly ingredientId: number;
  readonly plantWetTime: number;
  readonly timeToDry: number;
}

export interface FloorInput {
  readonly floorIndex: number;
  readonly tilesJson: string | readonly number[];
}

export interface EmployeeInput {
  readonly network?: number;
  readonly networkUid: string;
  readonly playfishUid?: number;
  readonly happiness: number;
  readonly task: number;
  readonly notify?: boolean;
}

export interface MailInput {
  readonly senderNetworkUid?: string;
  readonly recipientNetworkUid?: string;
  readonly globalItemIds?: readonly number[];
  readonly itemId?: number;
  readonly message?: string;
  readonly read?: boolean;
  readonly deleted?: boolean;
  readonly sendDate?: number;
  readonly deleteTime?: number;
  readonly type?: number;
}

export interface BulkMailInput extends MailInput {
  readonly recipientNetworkUids: readonly string[];
}

export interface BulkMailResult {
  readonly created: number;
  readonly liveNotified: number;
}

export interface GameEventInput {
  readonly eventType: number;
  readonly eventText: string;
  readonly createdAtUnix?: number;
}

export interface PricepointInput {
  readonly productType: number;
  readonly payoutParameter: number;
  readonly paymentProvider: number;
  readonly price: number;
  readonly currency: string;
  readonly currencyScale: number;
  readonly clientData?: string;
  readonly token: string;
  readonly enabled?: boolean;
}

export interface PurchasableItemInput {
  readonly skuId: number;
  readonly price: number;
  readonly currency: string;
  readonly token: string;
  readonly enabled?: boolean;
}

export interface IngredientMarketInput {
  readonly ingredientId: number;
  readonly price: number;
  readonly enabled?: boolean;
}

export async function listAdminUsers(page = 1, pageSize = 50, search = ''): Promise<AdminUserPage> {
  await ensureStarterFriends();
  const safePageSize = Math.min(100, Math.max(10, Math.trunc(pageSize) || 50));
  const requestedPage = Math.max(1, Math.trunc(page) || 1);
  const query = search.trim().slice(0, 100);
  const where: Prisma.UserProfileWhereInput = query ? { OR: [
    { networkUid: { contains: query } },
    { firstName: { contains: query } },
    { fullName: { contains: query } },
    { restaurantName: { contains: query } },
  ] } : {};
  const total = await prisma.userProfile.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(requestedPage, totalPages);
  const users = await prisma.userProfile.findMany({
    where,
    select: adminUserSummarySelect,
    orderBy: { networkUid: 'asc' },
    skip: (safePage - 1) * safePageSize,
    take: safePageSize,
  });
  return { users, page: safePage, pageSize: safePageSize, total, totalPages };
}

export async function listAdminUserOptions(): Promise<AdminUserOption[]> {
  return prisma.userProfile.findMany({
    select: { networkUid: true, firstName: true, fullName: true },
    orderBy: { networkUid: 'asc' },
  });
}

export function itemCatalog() {
  return fullCatalog();
}

export async function listEconomy() {
  await ensureEconomyCatalog();
  const [pricepoints, purchasableItems, ingredientMarketItems] = await Promise.all([
    prisma.pricepoint.findMany({ orderBy: { id: 'asc' } }),
    prisma.purchasableItem.findMany({ orderBy: { id: 'asc' } }),
    prisma.ingredientMarketItem.findMany({ orderBy: { ingredientId: 'asc' } }),
  ]);

  return { pricepoints, purchasableItems, ingredientMarketItems };
}

export async function createAdminUser(input: ProfileInput): Promise<AdminUser> {
  const clean = validateProfileInput(input, true);
  const id = profileKey(clean.networkUid);
  const { firstName, fullName } = clean.firstName ? clean : defaultProfileName(clean.networkUid);
  const starterOwnedItems = seedAdminOwnedItems(clean.networkUid, [...STARTER_BUILDING_ITEMS, ...STARTER_RESTAURANT_ITEMS]);

  await prisma.userProfile.create({
    data: {
      id,
      network: FACEBOOK_NETWORK,
      networkUid: clean.networkUid,
      playfishUid: clean.playfishUid,
      firstName,
      fullName,
      restaurantName: clean.restaurantName,
      imageUrl: clean.imageUrl,
      largeImageUrl: clean.largeImageUrl,
      gender: clean.gender,
      credits: clean.credits,
      cashBalance: clean.cashBalance,
      playCount: clean.playCount,
      userLevel: clean.userLevel,
      gourmetPoint: clean.gourmetPoint,
      nbVote: clean.nbVote,
      totalMark: clean.totalMark,
      trashPoint: clean.trashPoint,
      demandPoint: clean.demandPoint,
      musicPlay: clean.musicPlay,
      bookmarkCount: clean.bookmarkCount,
      activeFloorIndex: clean.activeFloorIndex,
      isInStreet: clean.isInStreet,
      saveVersion: clean.saveVersion,
      lastSave: clean.lastSave,
      lastSurveyTime: clean.lastSurveyTime,
      consecutionCount: clean.consecutionCount,
      ownedItems: { create: starterOwnedItems },
      inventoryItems: { create: seedAdminStarterRecipes(clean.networkUid) },
      ingredients: { create: seedAdminStarterIngredients(clean.networkUid) },
      floors: { create: seedAdminStarterFloors(clean.networkUid) },
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
      playfishUid: clean.playfishUid,
      firstName: clean.firstName,
      fullName: clean.fullName,
      restaurantName: clean.restaurantName,
      imageUrl: clean.imageUrl,
      largeImageUrl: clean.largeImageUrl,
      gender: clean.gender,
      credits: clean.credits,
      cashBalance: clean.cashBalance,
      playCount: clean.playCount,
      userLevel: clean.userLevel,
      gourmetPoint: clean.gourmetPoint,
      nbVote: clean.nbVote,
      totalMark: clean.totalMark,
      trashPoint: clean.trashPoint,
      demandPoint: clean.demandPoint,
      musicPlay: clean.musicPlay,
      bookmarkCount: clean.bookmarkCount,
      activeFloorIndex: clean.activeFloorIndex,
      isInStreet: clean.isInStreet,
      saveVersion: clean.saveVersion,
      lastSave: clean.lastSave,
      lastSurveyTime: clean.lastSurveyTime,
      consecutionCount: clean.consecutionCount,
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
    prisma.cashTransaction.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.storedImage.deleteMany(),
    prisma.gameEvent.deleteMany(),
    prisma.restaurantRank.deleteMany(),
    prisma.friendVisitCredit.deleteMany(),
    prisma.friendVisit.deleteMany(),
    prisma.mail.deleteMany(),
    prisma.employee.deleteMany(),
    prisma.restaurantFloor.deleteMany(),
    prisma.gardenPlot.deleteMany(),
    prisma.ingredientInventory.deleteMany(),
    prisma.inventoryItem.deleteMany(),
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

export async function upsertAdminInventoryItem(
  networkUid: string,
  globalItemId: number | null,
  input: InventoryInput,
): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const item = validateInventoryInput(input);
  const existingItemId = globalItemId === null ? item.globalItemId : boundedInt(globalItemId, 'globalItemId', 1, 9999999);

  if (existingItemId !== item.globalItemId) {
    await prisma.inventoryItem.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), globalItemId: existingItemId } });
  }

  await prisma.inventoryItem.upsert({
    where: { userProfileId_globalItemId: { userProfileId: profileKey(safeNetworkUid), globalItemId: item.globalItemId } },
    update: item,
    create: {
      id: inventoryKey(safeNetworkUid, item.globalItemId),
      userProfileId: profileKey(safeNetworkUid),
      ...item,
    },
  });

  return getAdminUser(safeNetworkUid);
}

export async function deleteAdminInventoryItem(networkUid: string, globalItemId: number): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safeGlobalItemId = boundedInt(globalItemId, 'globalItemId', 1, 9999999);
  await prisma.inventoryItem.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), globalItemId: safeGlobalItemId } });
  return getAdminUser(safeNetworkUid);
}

export async function upsertAdminIngredient(
  networkUid: string,
  globalItemId: number | null,
  input: IngredientInput,
): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const item = validateIngredientInput(input);
  const existingItemId = globalItemId === null ? item.globalItemId : boundedInt(globalItemId, 'globalItemId', 1, 9999999);

  if (existingItemId !== item.globalItemId) {
    await prisma.ingredientInventory.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), globalItemId: existingItemId } });
  }

  await prisma.ingredientInventory.upsert({
    where: { userProfileId_globalItemId: { userProfileId: profileKey(safeNetworkUid), globalItemId: item.globalItemId } },
    update: item,
    create: {
      id: ingredientKey(safeNetworkUid, item.globalItemId),
      userProfileId: profileKey(safeNetworkUid),
      ...item,
    },
  });

  return getAdminUser(safeNetworkUid);
}

export async function deleteAdminIngredient(networkUid: string, globalItemId: number): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safeGlobalItemId = boundedInt(globalItemId, 'globalItemId', 1, 9999999);
  await prisma.ingredientInventory.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), globalItemId: safeGlobalItemId } });
  return getAdminUser(safeNetworkUid);
}

export async function upsertAdminGardenPlot(networkUid: string, plotId: number | null, input: GardenPlotInput): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const plot = validateGardenPlotInput(input);
  const existingPlotId = plotId === null ? plot.plotId : boundedInt(plotId, 'plotId', 0, 99);

  if (existingPlotId !== plot.plotId) {
    await prisma.gardenPlot.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), plotId: existingPlotId } });
  }

  await prisma.gardenPlot.upsert({
    where: { userProfileId_plotId: { userProfileId: profileKey(safeNetworkUid), plotId: plot.plotId } },
    update: plot,
    create: {
      id: gardenPlotKey(safeNetworkUid, plot.plotId),
      userProfileId: profileKey(safeNetworkUid),
      ...plot,
    },
  });

  return getAdminUser(safeNetworkUid);
}

export async function deleteAdminGardenPlot(networkUid: string, plotId: number): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safePlotId = boundedInt(plotId, 'plotId', 0, 99);
  await prisma.gardenPlot.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), plotId: safePlotId } });
  return getAdminUser(safeNetworkUid);
}

export async function upsertAdminFloor(networkUid: string, floorIndex: number | null, input: FloorInput): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const floor = validateFloorInput(input);
  const existingFloorIndex = floorIndex === null ? floor.floorIndex : boundedInt(floorIndex, 'floorIndex', 0, 8);

  if (existingFloorIndex !== floor.floorIndex) {
    await prisma.restaurantFloor.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), floorIndex: existingFloorIndex } });
  }

  await prisma.restaurantFloor.upsert({
    where: { userProfileId_floorIndex: { userProfileId: profileKey(safeNetworkUid), floorIndex: floor.floorIndex } },
    update: floor,
    create: {
      id: floorKey(safeNetworkUid, floor.floorIndex),
      userProfileId: profileKey(safeNetworkUid),
      ...floor,
    },
  });

  return getAdminUser(safeNetworkUid);
}

export async function deleteAdminFloor(networkUid: string, floorIndex: number): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safeFloorIndex = boundedInt(floorIndex, 'floorIndex', 0, 8);
  await prisma.restaurantFloor.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), floorIndex: safeFloorIndex } });
  return getAdminUser(safeNetworkUid);
}

export async function upsertAdminEmployee(networkUid: string, employeeNetworkUid: string | null, input: EmployeeInput): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const employee = validateEmployeeInput(input);
  const existingEmployeeUid = employeeNetworkUid === null ? employee.networkUid : validateLooseUid(employeeNetworkUid, 'employeeNetworkUid');

  if (existingEmployeeUid !== employee.networkUid) {
    await prisma.employee.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), networkUid: existingEmployeeUid } });
  }

  await prisma.employee.upsert({
    where: { userProfileId_networkUid: { userProfileId: profileKey(safeNetworkUid), networkUid: employee.networkUid } },
    update: employee,
    create: {
      id: employeeKey(safeNetworkUid, employee.networkUid),
      userProfileId: profileKey(safeNetworkUid),
      ...employee,
    },
  });

  return getAdminUser(safeNetworkUid);
}

export async function deleteAdminEmployee(networkUid: string, employeeNetworkUid: string): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safeEmployeeUid = validateLooseUid(employeeNetworkUid, 'employeeNetworkUid');
  await prisma.employee.deleteMany({ where: { userProfileId: profileKey(safeNetworkUid), networkUid: safeEmployeeUid } });
  return getAdminUser(safeNetworkUid);
}

export async function createAdminMail(networkUid: string, input: MailInput): Promise<AdminUser> {
  const recipientNetworkUid = validateNetworkUid(input.recipientNetworkUid || networkUid);
  const senderNetworkUid = validateNetworkUid(input.senderNetworkUid || PLAYER_NETWORK_UID);
  const sender = await getAdminUser(senderNetworkUid);
  const recipient = await getAdminUser(recipientNetworkUid);
  const clean = validateMailInput(input);

  await prisma.mail.create({
    data: {
      senderProfileId: sender.id,
      recipientProfileId: recipient.id,
      senderNetwork: sender.network,
      senderNetworkUid: sender.networkUid,
      senderPlayfishUid: sender.playfishUid,
      recipientNetwork: recipient.network,
      recipientNetworkUid: recipient.networkUid,
      recipientPlayfishUid: recipient.playfishUid,
      globalItemIdsJson: JSON.stringify(clean.globalItemIds),
      itemId: clean.itemId,
      message: clean.message,
      read: clean.read,
      deleted: clean.deleted,
      sendDate: clean.sendDate,
      deleteTime: clean.deleteTime,
      type: clean.type,
    },
  });

  await grantAdminMailRewards(recipientNetworkUid, clean.type, clean.message, clean.globalItemIds);
  enqueueLiveMail(recipientNetworkUid, clean.type);

  return getAdminUser(recipientNetworkUid);
}

/** Send one type-safe admin-composed mail to several existing profiles. */
export async function createAdminMails(input: BulkMailInput): Promise<BulkMailResult> {
  const recipientNetworkUids = [...new Set(input.recipientNetworkUids.map(validateNetworkUid))];
  if (recipientNetworkUids.length === 0) return { created: 0, liveNotified: 0 };
  if (recipientNetworkUids.length > 10_000) throw new Error('Too many mail recipients.');

  const senderNetworkUid = validateNetworkUid(input.senderNetworkUid || SYSTEM_NETWORK_UID);
  const clean = validateComposedMailInput(input);
  const senderPromise = getAdminUser(senderNetworkUid);
  const recipients = [];
  for (const networkUidBatch of queryBatches(recipientNetworkUids)) {
    recipients.push(...await prisma.userProfile.findMany({ where: { networkUid: { in: networkUidBatch } } }));
  }
  const sender = await senderPromise;
  const byUid = new Map(recipients.map((recipient) => [recipient.networkUid, recipient]));
  const missing = recipientNetworkUids.filter((uid) => !byUid.has(uid));
  if (missing.length > 0) throw new Error(`Unknown recipient${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);

  await prisma.mail.createMany({
    data: recipientNetworkUids.map((recipientNetworkUid) => {
      const recipient = byUid.get(recipientNetworkUid)!;
      return {
        senderProfileId: sender.id,
        recipientProfileId: recipient.id,
        senderNetwork: sender.network,
        senderNetworkUid: sender.networkUid,
        senderPlayfishUid: sender.playfishUid,
        recipientNetwork: recipient.network,
        recipientNetworkUid: recipient.networkUid,
        recipientPlayfishUid: recipient.playfishUid,
        globalItemIdsJson: JSON.stringify(clean.globalItemIds),
        itemId: clean.itemId,
        message: clean.message,
        read: false,
        deleted: false,
        sendDate: clean.sendDate,
        deleteTime: 0,
        type: clean.type,
      };
    }),
  });

  let liveNotified = 0;
  for (const recipientNetworkUid of recipientNetworkUids) {
    await grantAdminMailRewards(recipientNetworkUid, clean.type, clean.message, clean.globalItemIds);
    if (enqueueLiveMail(recipientNetworkUid, clean.type)) liveNotified += 1;
  }
  return { created: recipientNetworkUids.length, liveNotified };
}

export async function listEnabledAccountNetworkUids(): Promise<string[]> {
  const accounts = await prisma.account.findMany({
    where: { disabled: false },
    select: { networkUid: true },
    orderBy: { usernameKey: 'asc' },
  });
  return accounts.map((account) => account.networkUid);
}

export async function updateAdminMail(networkUid: string, mailId: number, input: MailInput): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safeMailId = boundedInt(mailId, 'mailId', 1, 2147483647);
  const clean = validateMailInput(input);

  await prisma.mail.update({
    where: { id: safeMailId },
    data: {
      globalItemIdsJson: JSON.stringify(clean.globalItemIds),
      itemId: clean.itemId,
      message: clean.message,
      read: clean.read,
      deleted: clean.deleted,
      sendDate: clean.sendDate,
      deleteTime: clean.deleteTime,
      type: clean.type,
    },
  });

  return getAdminUser(safeNetworkUid);
}

export async function deleteAdminMail(networkUid: string, mailId: number): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safeMailId = boundedInt(mailId, 'mailId', 1, 2147483647);
  await prisma.mail.deleteMany({ where: { id: safeMailId } });
  return getAdminUser(safeNetworkUid);
}

export async function createAdminGameEvent(networkUid: string, input: GameEventInput): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const event = validateGameEventInput(input);

  await prisma.gameEvent.create({
    data: {
      userProfileId: profileKey(safeNetworkUid),
      ...event,
    },
  });

  return getAdminUser(safeNetworkUid);
}

export async function deleteAdminGameEvent(networkUid: string, eventId: number): Promise<AdminUser> {
  const safeNetworkUid = validateNetworkUid(networkUid);
  const safeEventId = boundedInt(eventId, 'eventId', 1, 2147483647);
  await prisma.gameEvent.deleteMany({ where: { id: safeEventId, userProfileId: profileKey(safeNetworkUid) } });
  return getAdminUser(safeNetworkUid);
}

export async function upsertAdminPricepoint(id: number | null, input: PricepointInput) {
  const item = validatePricepointInput(input);
  if (id === null) {
    return prisma.pricepoint.create({ data: item });
  }

  return prisma.pricepoint.update({ where: { id: boundedInt(id, 'id', 1, 2147483647) }, data: item });
}

export async function deleteAdminPricepoint(id: number): Promise<void> {
  await prisma.pricepoint.deleteMany({ where: { id: boundedInt(id, 'id', 1, 2147483647) } });
}

export async function upsertAdminPurchasableItem(id: number | null, input: PurchasableItemInput) {
  const item = validatePurchasableItemInput(input);
  if (id === null) {
    return prisma.purchasableItem.create({ data: item });
  }

  return prisma.purchasableItem.update({ where: { id: boundedInt(id, 'id', 1, 2147483647) }, data: item });
}

export async function deleteAdminPurchasableItem(id: number): Promise<void> {
  await prisma.purchasableItem.deleteMany({ where: { id: boundedInt(id, 'id', 1, 2147483647) } });
}

export async function upsertAdminIngredientMarketItem(id: number | null, input: IngredientMarketInput) {
  const item = validateIngredientMarketInput(input);
  if (id === null) {
    return prisma.ingredientMarketItem.create({ data: item });
  }

  return prisma.ingredientMarketItem.update({ where: { id: boundedInt(id, 'id', 1, 2147483647) }, data: item });
}

export async function deleteAdminIngredientMarketItem(id: number): Promise<void> {
  await prisma.ingredientMarketItem.deleteMany({ where: { id: boundedInt(id, 'id', 1, 2147483647) } });
}

export async function getAdminUser(networkUid: string): Promise<AdminUser> {
  return prisma.userProfile.findUniqueOrThrow({
    where: { id: profileKey(networkUid) },
    include: adminUserInclude,
  });
}

function validateProfileInput(input: ProfileInput, creating: boolean): Required<ProfileInput> {
  const networkUid = validateNetworkUid(input.networkUid);
  const defaultName = defaultProfileName(networkUid);
  const numericUid = Number.parseInt(networkUid, 10);

  return {
    networkUid,
    playfishUid: boundedInt(input.playfishUid ?? (Number.isFinite(numericUid) ? numericUid : 0), 'playfishUid', 0, 2147483647),
    firstName: cleanText(input.firstName || (creating ? defaultName.firstName : ''), 'firstName', 1, 32),
    fullName: cleanText(input.fullName || (creating ? defaultName.fullName : ''), 'fullName', 1, 64),
    restaurantName: cleanText(input.restaurantName || 'My Restaurant', 'restaurantName', 1, 48),
    imageUrl: cleanFreeText(input.imageUrl ?? '', 'imageUrl', 0, 500),
    largeImageUrl: cleanFreeText(input.largeImageUrl ?? '', 'largeImageUrl', 0, 500),
    gender: boundedInt(input.gender, 'gender', 0, 2),
    credits: boundedInt(input.credits, 'credits', 0, 999999999),
    cashBalance: boundedInt(input.cashBalance ?? 250, 'cashBalance', 0, 999999999),
    playCount: boundedInt(input.playCount ?? 1, 'playCount', 0, 999999999),
    userLevel: boundedInt(input.userLevel, 'userLevel', 1, 99),
    gourmetPoint: boundedInt(input.gourmetPoint, 'gourmetPoint', 0, 999999999),
    nbVote: boundedInt(input.nbVote ?? 0, 'nbVote', 0, 999999999),
    totalMark: boundedInt(input.totalMark ?? 0, 'totalMark', 0, 999999999),
    trashPoint: boundedInt(input.trashPoint, 'trashPoint', 0, 999999999),
    demandPoint: boundedInt(input.demandPoint ?? DEFAULT_NEW_PLAYER_DEMAND, 'demandPoint', 0, 999999999),
    musicPlay: boundedInt(input.musicPlay, 'musicPlay', 0, 999999999),
    bookmarkCount: boundedInt(input.bookmarkCount ?? 0, 'bookmarkCount', 0, 999999999),
    activeFloorIndex: boundedInt(input.activeFloorIndex, 'activeFloorIndex', 0, 8),
    isInStreet: Boolean(input.isInStreet),
    saveVersion: boundedInt(input.saveVersion ?? 1, 'saveVersion', 0, 999999999),
    lastSave: boundedInt(input.lastSave ?? 0, 'lastSave', 0, 2147483647),
    lastSurveyTime: boundedInt(input.lastSurveyTime ?? 0, 'lastSurveyTime', 0, 2147483647),
    consecutionCount: boundedInt(input.consecutionCount ?? 0, 'consecutionCount', 0, 999999999),
  };
}

function validateOwnedItemInput(input: OwnedItemInput) {
  const globalItemId = boundedInt(input.globalItemId, 'globalItemId', 1, 9999999);
  if (!isCatalogItemId(globalItemId)) {
    throw new Error('Choose an item from the catalog.');
  }

  return {
    globalItemId,
    positionX: boundedInt(input.positionX, 'positionX', -1000, 1000),
    positionY: boundedInt(input.positionY, 'positionY', -1000, 1000),
    data: boundedInt(input.data, 'data', 0, 255),
    roomIndex: boundedInt(input.roomIndex, 'roomIndex', 0, 8),
    employeeNetwork: boundedInt(input.employeeNetwork ?? 0, 'employeeNetwork', 0, 99),
    employeeNetworkUid: cleanFreeText(input.employeeNetworkUid ?? '', 'employeeNetworkUid', 0, 18),
    employeePlayfishUid: boundedInt(input.employeePlayfishUid ?? 0, 'employeePlayfishUid', 0, 2147483647),
  };
}

function validateInventoryInput(input: InventoryInput) {
  return {
    globalItemId: boundedInt(input.globalItemId, 'globalItemId', 1, 9999999),
    number: boundedInt(input.number, 'number', 0, 999999999),
    isSelected: Boolean(input.isSelected),
  };
}

function validateIngredientInput(input: IngredientInput) {
  return {
    globalItemId: boundedInt(input.globalItemId, 'globalItemId', 1, 9999999),
    number: boundedInt(input.number, 'number', 0, 999999999),
    isLocked: Boolean(input.isLocked),
  };
}

function validateGardenPlotInput(input: GardenPlotInput) {
  return {
    plotId: boundedInt(input.plotId, 'plotId', 0, 99),
    ingredientId: boundedInt(input.ingredientId, 'ingredientId', 0, 9999999),
    plantWetTime: boundedInt(input.plantWetTime, 'plantWetTime', 0, 2147483647),
    timeToDry: boundedInt(input.timeToDry, 'timeToDry', 0, 2147483647),
  };
}

function validateFloorInput(input: FloorInput) {
  const tilesJson = typeof input.tilesJson === 'string' ? input.tilesJson : JSON.stringify(input.tilesJson);
  const parsed = JSON.parse(tilesJson) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => Number.isInteger(Number(value)))) {
    throw new Error('tilesJson must be a JSON array of integers.');
  }

  return {
    floorIndex: boundedInt(input.floorIndex, 'floorIndex', 0, 8),
    tilesJson: JSON.stringify(parsed.map(Number)),
  };
}

function validateEmployeeInput(input: EmployeeInput) {
  return {
    network: boundedInt(input.network ?? FACEBOOK_NETWORK, 'network', 0, 99),
    networkUid: validateLooseUid(input.networkUid, 'networkUid'),
    playfishUid: boundedInt(input.playfishUid ?? (Number.parseInt(input.networkUid, 10) || 0), 'playfishUid', 0, 2147483647),
    happiness: boundedInt(input.happiness, 'happiness', 0, 4 * 60 * 60 * 1000),
    task: boundedInt(input.task, 'task', 0, 255),
    notify: Boolean(input.notify),
  };
}

function validateMailInput(input: MailInput) {
  return {
    senderNetworkUid: validateNetworkUid(input.senderNetworkUid || PLAYER_NETWORK_UID),
    recipientNetworkUid: input.recipientNetworkUid ? validateNetworkUid(input.recipientNetworkUid) : '',
    globalItemIds: [...(input.globalItemIds || [])].map((id) => boundedInt(id, 'globalItemId', 1, 9999999)),
    itemId: boundedInt(input.itemId ?? 0, 'itemId', 0, 9999999),
    message: cleanFreeText(input.message ?? '', 'message', 0, 500),
    read: Boolean(input.read),
    deleted: Boolean(input.deleted),
    sendDate: boundedInt(input.sendDate ?? nowSeconds(), 'sendDate', 0, 2147483647),
    deleteTime: boundedInt(input.deleteTime ?? 0, 'deleteTime', 0, 255),
    type: boundedInt(input.type ?? 1, 'type', 0, 255),
  };
}

function validateComposedMailInput(input: MailInput) {
  const clean = validateMailInput(input);
  const supportedTypes = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]);
  if (!supportedTypes.has(clean.type)) throw new Error('Choose a supported Restaurant City mail type.');
  for (const itemId of clean.globalItemIds) {
    if (!isCatalogItemId(itemId)) throw new Error(`Unknown item id ${itemId}.`);
  }

  if ((clean.type === 1 || clean.type === 3) && !clean.message.trim()) {
    throw new Error('This mail type requires a message.');
  }
  if ([1, 2, 3, 7].includes(clean.type) && clean.globalItemIds.length !== 0) {
    throw new Error('This mail type does not accept attached item ids.');
  }
  if ([4, 9, 10, 11].includes(clean.type) && clean.globalItemIds.length !== 1) {
    throw new Error('This mail type requires exactly one reward item.');
  }
  if (clean.type === 4 && !isGiftableItemId(clean.globalItemIds[0] ?? 0)) {
    throw new Error('Gift mail requires a visible, transferable catalog item.');
  }
  if (clean.type === 5 && (clean.globalItemIds.length < 1 || clean.globalItemIds.length > 5)) {
    throw new Error('Daily ingredient mail requires between one and five ingredients.');
  }
  if ((clean.type === 6 || clean.type === 8) && clean.globalItemIds.length !== 2) {
    throw new Error('Trade mail requires exactly two ingredient ids.');
  }
  if ([5, 6, 8].includes(clean.type) && clean.globalItemIds.some((id) => Math.floor(id / 1_000_000) !== 4)) {
    throw new Error('This mail type only accepts ingredient ids.');
  }
  if (clean.type === 9 && !isEmployeeSnackItem(clean.globalItemIds[0] ?? 0)) {
    throw new Error('Invite-food gift mail requires a shipped employee snack perk.');
  }
  if (clean.type === 10 && !isFoodKingEligibleItem(clean.globalItemIds[0] ?? 0)) {
    throw new Error('Food King mail requires a shipped Food King reward item.');
  }
  if (clean.type === 13 && clean.globalItemIds.length > 1) {
    throw new Error('Special-day mail accepts at most one reward item.');
  }
  if (clean.type === 13) {
    const presentThemes = new Set(['CHRISTMAS', 'VALENTINES', 'CHINESE_NEW_YEAR']);
    if (clean.globalItemIds.length === 0 && clean.message !== '3MillionFan') {
      throw new Error('A startup-message layout requires the 3MillionFan theme.');
    }
    if (clean.globalItemIds.length === 1 && !presentThemes.has(clean.message)) {
      throw new Error('A special-day present requires Christmas, Valentines, or Chinese New Year layout text.');
    }
  }
  if (clean.type === 7) {
    const amountText = clean.message.startsWith('PFC:') ? clean.message.slice(4) : clean.message;
    const amount = Number(amountText);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 999_999_999) {
      throw new Error('Currency mail requires a positive whole-number amount.');
    }
  }

  return clean;
}

async function grantAdminMailRewards(recipientNetworkUid: string, type: number, message: string, itemIds: readonly number[]): Promise<void> {
  if (type === 7 && !message.startsWith('PFC:')) {
    // RpcGetReceivedMails subtracts pending coin-mail amounts from the balance
    // delivered in the profile, then the open-mail popup adds them back. The
    // stored balance must therefore include the grant before the mail is sent.
    const amount = Number(message);
    await prisma.userProfile.update({
      where: { id: profileKey(recipientNetworkUid) },
      data: { credits: { increment: amount } },
    });
    return;
  }
  if (type === 7 && message.startsWith('PFC:')) {
    const amount = Number(message.slice(4));
    await prisma.userProfile.update({
      where: { id: profileKey(recipientNetworkUid) },
      data: { cashBalance: { increment: amount } },
    });
    return;
  }
  const displayOnlyReward = type === 4 || type === 5 || type === 9;
  const feedOrSpecialReward = type === 10 || type === 11 || type === 13;
  if (!displayOnlyReward && !feedOrSpecialReward) return;

  for (const itemId of itemIds) {
    // Coin/demand perk subtypes 602/603 are applied by the popup itself.
    const perkSubtype = Math.floor(itemId / 10_000);
    if (feedOrSpecialReward && (perkSubtype === 602 || perkSubtype === 603)) continue;
    await grantMailItem(recipientNetworkUid, itemId);
  }
}

function validateGameEventInput(input: GameEventInput) {
  return {
    eventType: boundedInt(input.eventType, 'eventType', 0, 255),
    eventText: cleanFreeText(input.eventText, 'eventText', 0, 1000),
    createdAtUnix: boundedInt(input.createdAtUnix ?? nowSeconds(), 'createdAtUnix', 0, 2147483647),
  };
}

function validatePricepointInput(input: PricepointInput) {
  return {
    productType: boundedInt(input.productType, 'productType', 0, 9999999),
    payoutParameter: boundedInt(input.payoutParameter, 'payoutParameter', 0, 999999999),
    paymentProvider: boundedInt(input.paymentProvider, 'paymentProvider', 0, 9999999),
    price: boundedInt(input.price, 'price', 0, 999999999),
    currency: cleanFreeText(input.currency || 'USD', 'currency', 1, 12),
    currencyScale: boundedInt(input.currencyScale, 'currencyScale', 0, 9),
    clientData: cleanFreeText(input.clientData ?? '', 'clientData', 0, 500),
    token: cleanToken(input.token),
    enabled: input.enabled !== false,
  };
}

function validatePurchasableItemInput(input: PurchasableItemInput) {
  return {
    skuId: boundedInt(input.skuId, 'skuId', 1, 9999999),
    price: boundedInt(input.price, 'price', 0, 999999999),
    currency: cleanFreeText(input.currency || 'PFC', 'currency', 1, 12),
    token: cleanToken(input.token),
    enabled: input.enabled !== false,
  };
}

function validateIngredientMarketInput(input: IngredientMarketInput) {
  return {
    ingredientId: boundedInt(input.ingredientId, 'ingredientId', 1, 9999999),
    price: boundedInt(input.price, 'price', 0, 999999999),
    enabled: input.enabled !== false,
  };
}

function validateNetworkUid(value: string): string {
  const networkUid = String(value ?? '').trim();
  if (!/^\d{1,18}$/.test(networkUid)) {
    throw new Error('User id must be 1 to 18 digits.');
  }
  return networkUid;
}

function validateLooseUid(value: string, field: string): string {
  return cleanFreeText(String(value ?? '').trim(), field, 1, 64);
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

function cleanFreeText(value: string, field: string, minLength: number, maxLength: number): string {
  const clean = String(value ?? '').trim();
  if (clean.length < minLength || clean.length > maxLength) {
    throw new Error(`${field} must be ${minLength}-${maxLength} characters.`);
  }
  return clean;
}

function cleanToken(value: string): string {
  const token = cleanFreeText(value, 'token', 1, 120);
  if (!/^[\w:.-]+$/.test(token)) {
    throw new Error('token may only contain letters, numbers, underscores, dots, dashes, and colons.');
  }
  return token;
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

function seedAdminOwnedItems(networkUid: string, seeds: readonly OwnedItemSeed[]) {
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

function seedAdminStarterRecipes(networkUid: string) {
  return STARTER_RECIPES.map((recipe) => ({
    id: inventoryKey(networkUid, recipe.id),
    globalItemId: recipe.id,
    number: recipe.level,
    isSelected: recipe.selected,
  }));
}

function seedAdminStarterIngredients(networkUid: string) {
  return STARTER_INGREDIENTS.map((ingredient) => ({
    id: ingredientKey(networkUid, ingredient.id),
    globalItemId: ingredient.id,
    number: ingredient.count,
    isLocked: false,
  }));
}

function seedAdminStarterFloors(networkUid: string) {
  return [0, 1].map((floorIndex) => ({
    id: floorKey(networkUid, floorIndex),
    floorIndex,
    tilesJson: JSON.stringify(Array.from({ length: 20 * 40 }, () => 0)),
  }));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
