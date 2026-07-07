import type { Mail, Pricepoint, PurchasableItem } from '@prisma/client';
import { prisma } from './client';
import { FACEBOOK_NETWORK, PLAYER_NETWORK_UID } from './defaults';
import { getAllFriends, getPlayerProfile, getProfiles, type NetworkUidData, type OwnedItemData, type StoredProfile } from './profile-store';
import type { ActiveAccount } from '../session';

const STATUS_OK = 0;
const STATUS_NOT_ENOUGH_CASH = 1;
const STARTING_CASH_BALANCE = 250;
const DEFAULT_CASH_COST = 1;
const GARDEN_WETNESS_PER_WATER_SECONDS = 3 * 60 * 60;
const GARDEN_MAX_WETNESS_SECONDS = 9 * 60 * 60;
const MAX_VISIT_ACTIVITY_GP = 15;
const VISIT_ACTIVITY_PAYOUTS: ReadonlyArray<readonly [number, number]> = [[1, 500], [2, 100], [5, 50]];
const MIN_VISIT_ACTIVITY_PAYOUT = 15;

export interface StatusBalance {
  readonly status: number;
  readonly balance: number;
}

export interface InventoryGift {
  readonly globalItemId: number;
  readonly number: number;
  readonly isSelected: boolean;
}

export type StoredMail = Mail;

export interface PollRequest {
  readonly synchronous: boolean;
  readonly requestTimeout: number;
  readonly ackEventIds: readonly number[];
}

export interface StoredImagePayload {
  readonly imageType: number;
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

export async function ensureEconomyCatalog(): Promise<void> {
  await prisma.$transaction([
    prisma.pricepoint.upsert({
      where: { token: 'coins_1000' },
      update: {},
      create: {
        productType: 1,
        payoutParameter: 1000,
        paymentProvider: 10,
        price: 99,
        currency: 'USD',
        currencyScale: 2,
        clientData: 'coins=1000',
        token: 'coins_1000',
      },
    }),
    prisma.pricepoint.upsert({
      where: { token: 'cash_25' },
      update: {},
      create: {
        productType: 2,
        payoutParameter: 25,
        paymentProvider: 10,
        price: 199,
        currency: 'USD',
        currencyScale: 2,
        clientData: 'cash=25',
        token: 'cash_25',
      },
    }),
    prisma.purchasableItem.upsert({
      where: { token: 'cash_item_3040001' },
      update: {},
      create: { skuId: 3040001, price: 1, currency: 'PFC', token: 'cash_item_3040001' },
    }),
    prisma.purchasableItem.upsert({
      where: { token: 'cash_item_3030010' },
      update: {},
      create: { skuId: 3030010, price: 1, currency: 'PFC', token: 'cash_item_3030010' },
    }),
    ...[4000000, 4000001, 4000002].map((ingredientId) => prisma.ingredientMarketItem.upsert({
      where: { ingredientId },
      update: {},
      create: { ingredientId, price: 1000 },
    })),
  ]);
}

export async function ingredientMarketItems(): Promise<Array<{ ingredientId: number; price: number }>> {
  await ensureEconomyCatalog();
  return prisma.ingredientMarketItem.findMany({
    where: { enabled: true },
    select: { ingredientId: true, price: true },
    orderBy: { ingredientId: 'asc' },
  });
}

export async function pricepoints(): Promise<Pricepoint[]> {
  await ensureEconomyCatalog();
  return prisma.pricepoint.findMany({ where: { enabled: true }, orderBy: { id: 'asc' } });
}

export async function purchasableItems(): Promise<PurchasableItem[]> {
  await ensureEconomyCatalog();
  return prisma.purchasableItem.findMany({ where: { enabled: true }, orderBy: { skuId: 'asc' } });
}

export async function cashBalance(account: ActiveAccount): Promise<number> {
  const profile = await ensureAccountProfile(account);
  return profile.cashBalance;
}

export async function initSession(account: ActiveAccount): Promise<void> {
  await ensureAccountProfile(account);
  await prisma.userProfile.update({
    where: { id: profileKey(account.networkUid) },
    data: { playCount: { increment: 1 } },
  });
}

export async function purchaseCoinsWithCash(account: ActiveAccount, token: string): Promise<StatusBalance> {
  const profile = await ensureAccountProfile(account);
  const cost = DEFAULT_CASH_COST;
  if (profile.cashBalance < cost) {
    return { status: STATUS_NOT_ENOUGH_CASH, balance: profile.cashBalance };
  }

  const nextBalance = profile.cashBalance - cost;
  await prisma.$transaction([
    prisma.userProfile.update({
      where: { id: profileKey(account.networkUid) },
      data: { cashBalance: nextBalance, credits: { increment: coinsFromToken(token) } },
    }),
    prisma.cashTransaction.create({
      data: cashTransactionData(account.networkUid, 'purchaseCoinsWithPfCash', token, -cost, nextBalance),
    }),
  ]);

  return { status: STATUS_OK, balance: nextBalance };
}

export async function purchaseCashOwnedItem(account: ActiveAccount, token: string, item: OwnedItemData): Promise<StatusBalance> {
  const profile = await ensureAccountProfile(account);
  const cost = DEFAULT_CASH_COST;
  if (profile.cashBalance < cost) {
    return { status: STATUS_NOT_ENOUGH_CASH, balance: profile.cashBalance };
  }

  const nextBalance = profile.cashBalance - cost;
  await prisma.$transaction([
    prisma.userProfile.update({
      where: { id: profileKey(account.networkUid) },
      data: { cashBalance: nextBalance },
    }),
    prisma.ownedItem.upsert({
      where: { userProfileId_serverId: { userProfileId: profileKey(account.networkUid), serverId: item.serverId } },
      update: ownedItemWriteData(item),
      create: {
        id: ownedItemKey(account.networkUid, item.serverId),
        userProfileId: profileKey(account.networkUid),
        ...ownedItemWriteData(item),
      },
    }),
    prisma.cashTransaction.create({
      data: cashTransactionData(account.networkUid, 'purchaseCashItem', token, -cost, nextBalance),
    }),
  ]);

  return { status: STATUS_OK, balance: nextBalance };
}

export async function purchaseCashIngredients(account: ActiveAccount, tokens: readonly string[]): Promise<StatusBalance> {
  const profile = await ensureAccountProfile(account);
  const cost = Math.max(1, tokens.length) * DEFAULT_CASH_COST;
  if (profile.cashBalance < cost) {
    return { status: STATUS_NOT_ENOUGH_CASH, balance: profile.cashBalance };
  }

  const nextBalance = profile.cashBalance - cost;
  await prisma.$transaction(async (tx) => {
    await tx.userProfile.update({ where: { id: profileKey(account.networkUid) }, data: { cashBalance: nextBalance } });
    for (const token of tokens) {
      const ingredientId = itemIdFromToken(token, 4000000);
      await tx.ingredientInventory.upsert({
        where: { userProfileId_globalItemId: { userProfileId: profileKey(account.networkUid), globalItemId: ingredientId } },
        update: { number: { increment: 1 } },
        create: {
          id: ingredientKey(account.networkUid, ingredientId),
          userProfileId: profileKey(account.networkUid),
          globalItemId: ingredientId,
          number: 1,
          isLocked: false,
        },
      });
    }
    await tx.cashTransaction.create({
      data: cashTransactionData(account.networkUid, 'purchaseCashItemIngredients', tokens.join(','), -cost, nextBalance),
    });
  });

  return { status: STATUS_OK, balance: nextBalance };
}

export async function receivedMails(account: ActiveAccount): Promise<StoredMail[]> {
  await ensureAccountProfile(account);
  return prisma.mail.findMany({
    where: { recipientProfileId: profileKey(account.networkUid), deleted: false },
    orderBy: { sendDate: 'desc' },
  });
}

export async function sendMail(account: ActiveAccount, mail: {
  recipient: NetworkUidData;
  globalItemIds: readonly number[];
  itemId: number;
  message: string;
  type: number;
}): Promise<number> {
  const sender = await ensureAccountProfile(account);
  const recipientUid = mail.recipient.networkUid || String(mail.recipient.playfishUid || PLAYER_NETWORK_UID);
  await ensureProfileByUid(recipientUid);

  await prisma.mail.create({
    data: {
      senderProfileId: profileKey(sender.networkUid),
      recipientProfileId: profileKey(recipientUid),
      senderNetwork: sender.network,
      senderNetworkUid: sender.networkUid,
      senderPlayfishUid: sender.playfishUid,
      recipientNetwork: mail.recipient.network || FACEBOOK_NETWORK,
      recipientNetworkUid: recipientUid,
      recipientPlayfishUid: mail.recipient.playfishUid,
      globalItemIdsJson: JSON.stringify(mail.globalItemIds),
      itemId: mail.itemId,
      message: mail.message.slice(0, 500),
      sendDate: nowSeconds(),
      deleteTime: 0,
      type: mail.type,
    },
  });

  return STATUS_OK;
}

export async function bookmarkCount(account: ActiveAccount): Promise<number> {
  const profile = await ensureAccountProfile(account);
  return profile.bookmarkCount;
}

export async function setBookmarkCount(account: ActiveAccount, count: number): Promise<number> {
  await ensureAccountProfile(account);
  await prisma.userProfile.update({
    where: { id: profileKey(account.networkUid) },
    data: { bookmarkCount: Math.max(0, Math.trunc(count)) },
  });
  return STATUS_OK;
}

export async function storeImage(account: ActiveAccount, imageType: number, data: Buffer, width: number, height: number): Promise<number> {
  await ensureAccountProfile(account);
  await prisma.storedImage.create({
    data: {
      userProfileId: profileKey(account.networkUid),
      imageType,
      data: new Uint8Array(data),
      width,
      height,
    },
  });

  const imageUrl = `/__api/profile-image/${encodeURIComponent(account.networkUid)}/${imageType}.png`;
  if (imageType === 2) {
    await prisma.userProfile.update({
      where: { id: profileKey(account.networkUid) },
      data: { largeImageUrl: imageUrl },
    });
  } else {
    await prisma.userProfile.update({
      where: { id: profileKey(account.networkUid) },
      data: { imageUrl },
    });
  }

  return STATUS_OK;
}

export async function latestStoredImage(networkUid: string, imageType: number): Promise<StoredImagePayload | null> {
  const image = await prisma.storedImage.findFirst({
    where: { userProfileId: profileKey(networkUid), imageType },
    orderBy: { createdAt: 'desc' },
  });

  if (!image) {
    return null;
  }

  return {
    imageType: image.imageType,
    width: image.width,
    height: image.height,
    data: Buffer.from(image.data),
  };
}

export async function rankRestaurant(account: ActiveAccount, target: NetworkUidData, rating: number): Promise<number> {
  await ensureAccountProfile(account);
  const targetNetworkUid = target.networkUid || String(target.playfishUid || PLAYER_NETWORK_UID);
  const targetProfile = await ensureProfileByUid(targetNetworkUid);
  await prisma.restaurantRank.upsert({
    where: { fromProfileId_targetNetworkUid: { fromProfileId: profileKey(account.networkUid), targetNetworkUid } },
    update: { rating },
    create: {
      id: `${profileKey(account.networkUid)}:rank:${targetNetworkUid}`,
      fromProfileId: profileKey(account.networkUid),
      targetProfileId: targetProfile.id,
      targetNetwork: target.network || FACEBOOK_NETWORK,
      targetNetworkUid,
      targetPlayfishUid: target.playfishUid,
      rating,
    },
  });
  await prisma.userProfile.update({
    where: { id: targetProfile.id },
    data: {
      nbVote: { increment: 1 },
      totalMark: { increment: rating },
    },
  });
  return STATUS_OK;
}

export async function firstVisitFriend(account: ActiveAccount, friend: NetworkUidData): Promise<{ status: number; gift: InventoryGift }> {
  await ensureAccountProfile(account);
  const friendNetworkUid = friend.networkUid || String(friend.playfishUid || PLAYER_NETWORK_UID);
  await ensureProfileByUid(friendNetworkUid);
  const existing = await prisma.friendVisit.findUnique({
    where: { userProfileId_friendNetworkUid: { userProfileId: profileKey(account.networkUid), friendNetworkUid } },
  });
  const giftIngredientId = existing?.giftIngredientId ?? defaultIngredient(friendNetworkUid);
  const now = nowSeconds();

  await prisma.$transaction(async (tx) => {
    await tx.friendVisit.upsert({
      where: { userProfileId_friendNetworkUid: { userProfileId: profileKey(account.networkUid), friendNetworkUid } },
      update: { lastVisitedAt: now },
      create: {
        id: `${profileKey(account.networkUid)}:visit:${friendNetworkUid}`,
        userProfileId: profileKey(account.networkUid),
        friendNetwork: friend.network || FACEBOOK_NETWORK,
        friendNetworkUid,
        friendPlayfishUid: friend.playfishUid,
        firstVisitedAt: now,
        lastVisitedAt: now,
        giftIngredientId,
      },
    });
    if (!existing) {
      await tx.ingredientInventory.upsert({
        where: { userProfileId_globalItemId: { userProfileId: profileKey(account.networkUid), globalItemId: giftIngredientId } },
        update: { number: { increment: 1 } },
        create: {
          id: ingredientKey(account.networkUid, giftIngredientId),
          userProfileId: profileKey(account.networkUid),
          globalItemId: giftIngredientId,
          number: 1,
          isLocked: false,
        },
      });
    }
  });

  return { status: STATUS_OK, gift: { globalItemId: giftIngredientId, number: 1, isSelected: false } };
}

export async function streetUsers(account: ActiveAccount, count: number): Promise<StoredProfile[]> {
  const friends = await getAllFriends(account.networkUid);
  return friends.slice(0, Math.max(0, count || friends.length));
}

export async function gourmetStreetUsers(account: ActiveAccount, count: number): Promise<StoredProfile[]> {
  const friends = await getAllFriends(account.networkUid);
  return [...friends]
    .sort((a, b) => b.gourmetPoint - a.gourmetPoint)
    .slice(0, Math.max(0, count || friends.length));
}

export async function swapIngredient(account: ActiveAccount, target: NetworkUidData, offeredToken: string, requestedToken: string): Promise<number> {
  await ensureAccountProfile(account);
  await ensureProfileByUid(target.networkUid || String(target.playfishUid || PLAYER_NETWORK_UID));
  const offered = itemIdFromToken(offeredToken, 4000000);
  const requested = itemIdFromToken(requestedToken, 4000001);
  await prisma.$transaction(async (tx) => {
    await tx.ingredientInventory.upsert({
      where: { userProfileId_globalItemId: { userProfileId: profileKey(account.networkUid), globalItemId: offered } },
      update: { number: { decrement: 1 } },
      create: { id: ingredientKey(account.networkUid, offered), userProfileId: profileKey(account.networkUid), globalItemId: offered, number: 0 },
    });
    await tx.ingredientInventory.upsert({
      where: { userProfileId_globalItemId: { userProfileId: profileKey(account.networkUid), globalItemId: requested } },
      update: { number: { increment: 1 } },
      create: { id: ingredientKey(account.networkUid, requested), userProfileId: profileKey(account.networkUid), globalItemId: requested, number: 1 },
    });
  });
  return STATUS_OK;
}

export async function buyMysteryBox(account: ActiveAccount, category: string, tokens: readonly string[]): Promise<number> {
  await ensureAccountProfile(account);
  const chosen = itemIdFromToken(tokens[0] ?? category, 3040001);
  await prisma.inventoryItem.upsert({
    where: { userProfileId_globalItemId: { userProfileId: profileKey(account.networkUid), globalItemId: chosen } },
    update: { number: { increment: 1 } },
    create: {
      id: inventoryKey(account.networkUid, chosen),
      userProfileId: profileKey(account.networkUid),
      globalItemId: chosen,
      number: 1,
      isSelected: false,
    },
  });
  return chosen;
}

export async function replyQuiz(account: ActiveAccount, quizId: number, answer: string, correct: boolean): Promise<number> {
  await ensureAccountProfile(account);
  const reward = correct ? 100 : 10;
  const profile = await prisma.userProfile.update({
    where: { id: profileKey(account.networkUid) },
    data: { credits: { increment: reward } },
  });
  await prisma.gameEvent.create({
    data: {
      userProfileId: profileKey(account.networkUid),
      eventType: 25,
      eventText: JSON.stringify({ quizId, answer, correct, reward }),
      createdAtUnix: nowSeconds(),
    },
  });
  return profile.credits;
}

export async function waterFriendGarden(account: ActiveAccount, visitor: NetworkUidData, plotOwner: NetworkUidData, plotId: number): Promise<number> {
  const player = await ensureAccountProfile(account);
  const ownerNetworkUid = targetNetworkUid(plotOwner, targetNetworkUid(visitor, PLAYER_NETWORK_UID));
  const owner = await ensureProfileByUid(ownerNetworkUid);
  const now = nowSeconds();
  const today = new Date(now * 1000).toISOString().slice(0, 10);

  await prisma.$transaction(async (tx) => {
    const plot = await tx.gardenPlot.findUnique({
      where: { userProfileId_plotId: { userProfileId: owner.id, plotId } },
    });

    if (plot && plot.ingredientId > 0) {
      await tx.gardenPlot.update({
        where: { userProfileId_plotId: { userProfileId: owner.id, plotId } },
        data: { timeToDry: nextWaterLevel(plot.timeToDry, plot.updatedAt) },
      });
    }

    if (owner.networkUid !== account.networkUid) {
      const existingVisit = await tx.friendVisit.findUnique({
        where: { userProfileId_friendNetworkUid: { userProfileId: player.id, friendNetworkUid: owner.networkUid } },
      });
      const alreadyVisitedToday = existingVisit?.visitsTodayDate === today && existingVisit.visitsTodayCount > 0;
      const completedToday = await tx.friendVisit.count({
        where: { userProfileId: player.id, visitsTodayDate: today, visitsTodayCount: { gt: 0 } },
      });
      const reward = alreadyVisitedToday ? 0 : visitReward(completedToday);

      await tx.friendVisit.upsert({
        where: { userProfileId_friendNetworkUid: { userProfileId: player.id, friendNetworkUid: owner.networkUid } },
        update: {
          friendNetwork: plotOwner.network || FACEBOOK_NETWORK,
          friendPlayfishUid: plotOwner.playfishUid,
          lastVisitedAt: now,
          visitsTodayDate: today,
          visitsTodayCount: alreadyVisitedToday ? { increment: 1 } : 1,
        },
        create: {
          id: `${player.id}:visit:${owner.networkUid}`,
          userProfileId: player.id,
          friendNetwork: plotOwner.network || FACEBOOK_NETWORK,
          friendNetworkUid: owner.networkUid,
          friendPlayfishUid: plotOwner.playfishUid,
          firstVisitedAt: now,
          lastVisitedAt: now,
          giftIngredientId: defaultIngredient(owner.networkUid),
          visitsTodayDate: today,
          visitsTodayCount: 1,
        },
      });

      if (reward > 0) {
        await tx.userProfile.update({
          where: { id: player.id },
          data: {
            credits: { increment: reward },
            gourmetPoint: { increment: Math.min(reward, MAX_VISIT_ACTIVITY_GP) },
          },
        });
        await tx.friendVisitCredit.upsert({
          where: { userProfileId_friendNetworkUid: { userProfileId: player.id, friendNetworkUid: owner.networkUid } },
          update: { creditedAt: now },
          create: {
            id: `${player.id}:visit-credit:${owner.networkUid}`,
            userProfileId: player.id,
            friendNetwork: plotOwner.network || FACEBOOK_NETWORK,
            friendNetworkUid: owner.networkUid,
            friendPlayfishUid: plotOwner.playfishUid,
            creditedAt: now,
          },
        });
      }
    }

    await tx.gameEvent.create({
      data: {
        userProfileId: player.id,
        eventType: 43,
        eventText: JSON.stringify({ visitor, plotOwner, plotId, ownerNetworkUid }),
        createdAtUnix: now,
      },
    });
  });

  return STATUS_OK;
}

export async function sendNotification(account: ActiveAccount, recipient: NetworkUidData): Promise<number> {
  await ensureAccountProfile(account);
  const recipientNetworkUid = recipient.networkUid || String(recipient.playfishUid || PLAYER_NETWORK_UID);
  const recipientProfile = await findProfileByUid(recipientNetworkUid);
  await prisma.notification.create({
    data: {
      senderProfileId: profileKey(account.networkUid),
      recipientProfileId: recipientProfile?.id,
      recipientNetwork: recipient.network || FACEBOOK_NETWORK,
      recipientNetworkUid,
      recipientPlayfishUid: recipient.playfishUid,
      createdAtUnix: nowSeconds(),
    },
  });
  return STATUS_OK;
}

export async function recordGameEvent(account: ActiveAccount, eventType: number, eventText: string): Promise<void> {
  await ensureAccountProfile(account);
  await prisma.gameEvent.create({
    data: {
      userProfileId: profileKey(account.networkUid),
      eventType,
      eventText: eventText.slice(0, 1000),
      createdAtUnix: nowSeconds(),
    },
  });
}

export async function pollEvents(account: ActiveAccount, request: PollRequest): Promise<{ minPollInterval: number; requestTimeout: number }> {
  await ensureAccountProfile(account);
  const requestTimeout = boundedInt(request.requestTimeout, 5000, 120000, 30000);
  return {
    minPollInterval: request.synchronous ? 30000 : 0,
    requestTimeout,
  };
}

export async function timeToken(account: ActiveAccount): Promise<Buffer> {
  await ensureAccountProfile(account);
  const raw = `${account.networkUid}:${nowSeconds()}`;
  return Buffer.from(raw, 'utf8');
}

export function mailItemIds(mail: StoredMail): number[] {
  try {
    const parsed = JSON.parse(mail.globalItemIdsJson) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

async function ensureAccountProfile(account: ActiveAccount): Promise<StoredProfile> {
  const profile = await getPlayerProfile(account);
  if (profile.cashBalance <= 0) {
    return prisma.userProfile.update({
      where: { id: profileKey(account.networkUid) },
      data: { cashBalance: STARTING_CASH_BALANCE },
      include: {
        ownedItems: { orderBy: { serverId: 'asc' } },
        inventoryItems: { orderBy: { globalItemId: 'asc' } },
        ingredients: { orderBy: { globalItemId: 'asc' } },
        gardenPlots: { orderBy: { plotId: 'asc' } },
        floors: { orderBy: { floorIndex: 'asc' } },
        employees: { orderBy: { networkUid: 'asc' } },
        visits: { orderBy: { lastVisitedAt: 'desc' } },
      },
    });
  }
  return profile;
}

async function ensureProfileByUid(networkUid: string): Promise<StoredProfile> {
  const found = await getProfiles([networkUid], '');
  if (found[0]) {
    return found[0];
  }
  return getPlayerProfile({
    username: `User${networkUid}`,
    networkUid,
    playfishUid: Number.parseInt(networkUid, 10) || 0,
  });
}

async function findProfileByUid(networkUid: string) {
  return prisma.userProfile.findUnique({ where: { id: profileKey(networkUid) } });
}

function cashTransactionData(networkUid: string, kind: string, token: string, amount: number, balanceAfter: number) {
  return {
    userProfileId: profileKey(networkUid),
    kind,
    token,
    amount,
    balanceAfter,
    createdAtUnix: nowSeconds(),
  };
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

function coinsFromToken(token: string): number {
  return itemIdFromToken(token, 1000);
}

function itemIdFromToken(token: string, fallback: number): number {
  const match = String(token).match(/\d+/);
  const value = match ? Number.parseInt(match[0] ?? '', 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function targetNetworkUid(value: NetworkUidData, fallback: string): string {
  return value.networkUid || String(value.playfishUid || fallback);
}

function nextWaterLevel(currentWetness: number, wateredAt: Date): number {
  const elapsed = Math.max(0, Math.floor((Date.now() - wateredAt.getTime()) / 1000));
  const remainingWetness = Math.max(0, Math.min(currentWetness, GARDEN_MAX_WETNESS_SECONDS) - elapsed);
  return Math.min(GARDEN_MAX_WETNESS_SECONDS, remainingWetness + GARDEN_WETNESS_PER_WATER_SECONDS);
}

function visitReward(completedActivitiesToday: number): number {
  for (const [threshold, reward] of VISIT_ACTIVITY_PAYOUTS) {
    if (completedActivitiesToday < threshold) {
      return reward;
    }
  }

  return MIN_VISIT_ACTIVITY_PAYOUT;
}

function boundedInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }

  return value;
}

function defaultIngredient(seed: string): number {
  return 4000000 + ((Number.parseInt(seed, 10) || 0) % 3);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
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
