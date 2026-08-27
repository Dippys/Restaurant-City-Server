import type { Mail, Pricepoint, PurchasableItem } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from './client';
import { FACEBOOK_NETWORK, PLAYER_NETWORK_UID, SYSTEM_NETWORK_UID, isNpcUid } from './defaults';
import { getPlayerProfile, getProfiles, type NetworkUidData, type OwnedItemData, type StoredProfile } from './profile-store';
import { ensureDailyContent, sendNpcGift, grantMailItem } from './system-mail';
import { resolveIngredientId, ingredientRarity, firstVisitIngredientId } from './ingredient-catalog';
import { coinBundleForToken, ingredientCashCost, ownedItemCashCost } from './cash-catalog';
import type { ActiveAccount } from '../session';
import { enqueueLiveMail, pollLiveEvents, touchOnline, type LiveEvent } from '../live-events';
import { selectGourmetStreetProfiles, selectHireCandidateProfiles, selectRandomStreetProfiles } from '../rpc/street-roster';

const STATUS_OK = 0;
const STATUS_NOT_ENOUGH_CASH = 1;
const STATUS_INVALID_TOKEN = 4;

// Client mail type ids (see com.playfish.rpc.cooking.RpcClient in the SWF).
const MAIL_TYPE_GIFT = 4;
const MAIL_TYPE_SECURECHANGE = 6;
const MAIL_TYPE_SECUREECHANGE_OK = 8;
const STARTING_CASH_BALANCE = 250;
const GARDEN_WETNESS_PER_WATER_SECONDS = 3 * 60 * 60;
const GARDEN_MAX_WETNESS_SECONDS = 9 * 60 * 60;
const MAX_VISIT_ACTIVITY_GP = 15;
const VISIT_ACTIVITY_PAYOUTS: ReadonlyArray<readonly [number, number]> = [[1, 500], [2, 100], [5, 50]];
const MIN_VISIT_ACTIVITY_PAYOUT = 15;
const initializedPlayCountSessions = new Set<string>();

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

export async function initSession(account: ActiveAccount): Promise<string> {
  const profile = await ensureAccountProfile(account);
  if (shouldIncrementPlayCountOnInit(profile)) {
    initializedPlayCountSessions.add(account.networkUid);
    await prisma.userProfile.update({
      where: { id: profileKey(account.networkUid) },
      data: { playCount: { increment: 1 } },
    });
  }
  await ensureDailyContent(account);
  if (!account.sessionId) {
    return '';
  }
  const rpcSessionToken = randomBytes(24).toString('base64url');
  await prisma.session.update({
    where: { id: account.sessionId },
    data: {
      rpcSessionToken,
      rpcSaveVersion: 0,
      rpcSaveTime: 0,
      rpcSaveDigest: '',
    },
  });
  return rpcSessionToken;
}

function shouldIncrementPlayCountOnInit(profile: StoredProfile): boolean {
  if (initializedPlayCountSessions.has(profile.networkUid)) {
    return false;
  }

  // The Flash tutorial stays active until the player has two employees: the
  // player character plus one hired friend (see WorldStreet's < 2 tutorial gate).
  return profile.playCount > 1 || profile.employees.length >= 2 || profile.gourmetPoint > 0 || profile.userLevel > 1;
}

export async function purchaseCoinsWithCash(account: ActiveAccount, token: string): Promise<StatusBalance> {
  const profile = await ensureAccountProfile(account);
  const bundle = coinBundleForToken(token);
  if (!bundle) {
    return { status: STATUS_INVALID_TOKEN, balance: profile.cashBalance };
  }
  const cost = bundle.cashCost;
  if (profile.cashBalance < cost) {
    return { status: STATUS_NOT_ENOUGH_CASH, balance: profile.cashBalance };
  }

  const nextBalance = profile.cashBalance - cost;
  await prisma.$transaction([
    prisma.userProfile.update({
      where: { id: profileKey(account.networkUid) },
      data: { cashBalance: nextBalance, credits: { increment: bundle.coinPayout } },
    }),
    prisma.cashTransaction.create({
      data: cashTransactionData(account.networkUid, 'purchaseCoinsWithPfCash', token, -cost, nextBalance),
    }),
  ]);

  return { status: STATUS_OK, balance: nextBalance };
}

export async function purchaseCashOwnedItem(account: ActiveAccount, token: string, item: OwnedItemData): Promise<StatusBalance> {
  const profile = await ensureAccountProfile(account);
  const cost = ownedItemCashCost(token, item.globalItemId);
  if (cost === null) {
    return { status: STATUS_INVALID_TOKEN, balance: profile.cashBalance };
  }
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
  const cost = ingredientCashCost(tokens);
  if (cost === null) {
    return { status: STATUS_INVALID_TOKEN, balance: profile.cashBalance };
  }
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
  await ensureDailyContent(account);
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

  if (mail.type === MAIL_TYPE_SECURECHANGE) {
    const playerGives = mail.globalItemIds[0] ?? 0;
    const playerReceives = mail.globalItemIds[1] ?? 0;
    if (
      mail.globalItemIds.length !== 2
      || resolveIngredientId(String(playerGives)) !== playerGives
      || resolveIngredientId(String(playerReceives)) !== playerReceives
      || !(await hasIngredientStock(account.networkUid, playerGives))
    ) {
      return STATUS_INVALID_TOKEN;
    }
  }

  // NPC recipients have no client to act, so the server responds on their behalf:
  // trade requests are auto-accepted and gifts are reciprocated.
  if (isNpcUid(recipientUid)) {
    if (mail.type === MAIL_TYPE_SECURECHANGE) {
      return autoAcceptNpcTrade(account, recipientUid, mail.globalItemIds);
    }

    await persistMail(sender, recipientUid, mail);
    if (mail.type === MAIL_TYPE_GIFT) {
      await sendNpcGift(account, recipientUid);
    }
    return STATUS_OK;
  }

  await persistMail(sender, recipientUid, mail);
  // A gift's item is not added by the recipient's client on open (it only shows
  // "item added"), so the server persists it to the recipient — matching PlayFish.
  if (mail.type === MAIL_TYPE_GIFT) {
    await grantMailItem(recipientUid, mail.globalItemIds[0] ?? 0);
  }
  return STATUS_OK;
}

async function persistMail(sender: StoredProfile, recipientUid: string, mail: {
  recipient: NetworkUidData;
  globalItemIds: readonly number[];
  itemId: number;
  message: string;
  type: number;
}): Promise<void> {
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
  enqueueLiveMail(recipientUid, mail.type);
}

// A player mailed a trade request to an NPC. The offer carries both ingredient ids
// (globalItemIds[0] = player gives, [1] = NPC gives). The NPC "accepts" instantly:
// the player gives item 0 and receives item 1, then gets a confirmation mail.
async function autoAcceptNpcTrade(player: ActiveAccount, npcUid: string, globalItemIds: readonly number[]): Promise<number> {
  const playerGives = globalItemIds[0] ?? 0;
  const playerReceives = globalItemIds[1] ?? 0;
  const npcProfile = await ensureProfileByUid(npcUid);

  const status = await prisma.$transaction(async (tx) => {
    if (!(await hasIngredientStock(player.networkUid, playerGives, tx))) return STATUS_INVALID_TOKEN;
    await adjustIngredient(tx, player.networkUid, playerGives, -1);
    await adjustIngredient(tx, player.networkUid, playerReceives, 1, true);
    await deliverNpcTradeConfirmation(player, npcProfile, playerGives, playerReceives, tx);
    return STATUS_OK;
  });

  if (status !== STATUS_OK) return status;
  enqueueLiveMail(player.networkUid, MAIL_TYPE_SECUREECHANGE_OK);
  return STATUS_OK;
}

async function deliverNpcTradeConfirmation(
  player: ActiveAccount,
  npc: StoredProfile,
  playerGives: number,
  playerReceives: number,
  tx: any = prisma,
): Promise<void> {
  await tx.mail.create({
    data: {
      senderProfileId: profileKey(npc.networkUid),
      recipientProfileId: profileKey(player.networkUid),
      senderNetwork: npc.network || FACEBOOK_NETWORK,
      senderNetworkUid: npc.networkUid,
      senderPlayfishUid: npc.playfishUid,
      recipientNetwork: FACEBOOK_NETWORK,
      recipientNetworkUid: player.networkUid,
      recipientPlayfishUid: player.playfishUid,
      globalItemIdsJson: JSON.stringify([playerReceives, playerGives]),
      itemId: 0,
      message: '',
      sendDate: nowSeconds(),
      deleteTime: 0,
      type: MAIL_TYPE_SECUREECHANGE_OK,
    },
  });
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

  await prisma.$transaction(async (tx) => {
    // A player has a single standing rank per restaurant. Re-ranking replaces the
    // previous rating: adjust totalMark by the delta and count nbVote only once.
    const previous = await tx.restaurantRank.findUnique({
      where: { fromProfileId_targetNetworkUid: { fromProfileId: profileKey(account.networkUid), targetNetworkUid } },
    });
    const markDelta = previous ? rating - previous.rating : rating;
    const voteDelta = previous ? 0 : 1;

    await tx.restaurantRank.upsert({
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

    await tx.userProfile.update({
      where: { id: targetProfile.id },
      data: {
        nbVote: { increment: voteDelta },
        totalMark: { increment: markDelta },
      },
    });
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
  const giftIngredientId = existing?.giftIngredientId ?? firstVisitIngredientId();
  const now = nowSeconds();

  // Record the visit only. The returned gift is added to the visitor's inventory
  // CLIENT-side (RpcFirstTimeVisitFriend adds it and it persists via saveProfile),
  // so the server must not also grant it — that would double the gift on reload.
  await prisma.friendVisit.upsert({
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

  return { status: STATUS_OK, gift: { globalItemId: giftIngredientId, number: 1, isSelected: false } };
}

export async function streetUsers(account: ActiveAccount, count: number): Promise<StoredProfile[]> {
  const owner = await getPlayerProfile(account);
  const friendNetworkUids = new Set(owner.employees.map((employee) => employee.networkUid));
  const profiles = await enabledPlayerProfiles([account.networkUid, ...friendNetworkUids]);
  return selectRandomStreetProfiles(profiles, account.networkUid, friendNetworkUids, count);
}

export async function gourmetStreetUsers(account: ActiveAccount, count: number): Promise<StoredProfile[]> {
  await getPlayerProfile(account);
  const profiles = await enabledPlayerProfiles([account.networkUid]);
  return selectGourmetStreetProfiles(profiles, account.networkUid, count);
}

export async function hireCandidates(account: ActiveAccount, count: number): Promise<StoredProfile[]> {
  const owner = await getPlayerProfile(account);
  const friendNetworkUids = new Set(owner.employees.map((employee) => employee.networkUid));
  const profiles = await enabledPlayerProfiles([account.networkUid, ...friendNetworkUids]);
  return selectHireCandidateProfiles(profiles, account.networkUid, friendNetworkUids, count);
}

async function enabledPlayerProfiles(excludedNetworkUids: readonly string[]): Promise<StoredProfile[]> {
  const excluded = [...new Set([PLAYER_NETWORK_UID, SYSTEM_NETWORK_UID, ...excludedNetworkUids])];
  const accounts = await prisma.account.findMany({
    where: {
      disabled: false,
      networkUid: { notIn: excluded },
    },
    select: { networkUid: true },
  });
  return getProfiles(accounts.map((account) => account.networkUid), '');
}

// The Flash success handlers update both ingredient lists in memory but emit no
// saveProfile ingredient-delta audit. Persist both real players here, validate a
// secure offer against its live mail, consume it, and create the confirmation in
// the same transaction so a retry cannot observe half a trade.
export async function swapIngredient(
  account: ActiveAccount,
  target: NetworkUidData,
  offeredToken: string,
  requestedToken: string,
  secure: boolean,
  mailId: number,
): Promise<number> {
  await ensureAccountProfile(account);
  const targetUid = target.networkUid || String(target.playfishUid || PLAYER_NETWORK_UID);
  const targetProfile = await ensureProfileByUid(targetUid);
  // The client sends each ingredient's opaque `hash`, not its numeric id.
  const offered = resolveIngredientId(offeredToken);
  const requested = resolveIngredientId(requestedToken);
  if (offered === null || requested === null) return STATUS_INVALID_TOKEN;

  const status = await prisma.$transaction(async (tx) => {
    if (!(await hasIngredientStock(account.networkUid, offered, tx))) return STATUS_INVALID_TOKEN;

    if (secure) {
      if (mailId <= 0) return STATUS_INVALID_TOKEN;
      const mail = await tx.mail.findFirst({
        where: {
          id: mailId,
          senderProfileId: targetProfile.id,
          recipientProfileId: profileKey(account.networkUid),
          type: MAIL_TYPE_SECURECHANGE,
          deleted: false,
        },
      });
      if (!mail) return STATUS_INVALID_TOKEN;
      const mailItems = readStoredNumberArray(mail.globalItemIdsJson);
      if (mailItems.length !== 2 || mailItems[0] !== requested || mailItems[1] !== offered) {
        return STATUS_INVALID_TOKEN;
      }
    } else if (!isNpcUid(targetUid)) {
      const targetItem = await tx.ingredientInventory.findUnique({
        where: { userProfileId_globalItemId: { userProfileId: profileKey(targetUid), globalItemId: requested } },
      });
      const offeredRarity = ingredientRarity(offered);
      const requestedRarity = ingredientRarity(requested);
      if (!targetItem || targetItem.number < 1 || targetItem.isLocked || offeredRarity === null || requestedRarity === null || offeredRarity < requestedRarity) {
        return STATUS_INVALID_TOKEN;
      }
    }

    if (!isNpcUid(targetUid) && !(await hasIngredientStock(targetUid, requested, tx))) return STATUS_INVALID_TOKEN;

    await adjustIngredient(tx, account.networkUid, offered, -1);
    await adjustIngredient(tx, account.networkUid, requested, 1, true);
    if (!isNpcUid(targetUid)) {
      await adjustIngredient(tx, targetUid, requested, -1);
      await adjustIngredient(tx, targetUid, offered, 1, true);
    }
    if (secure) {
      await tx.mail.update({ where: { id: mailId }, data: { deleted: true } });
    }
    await deliverTradeConfirmation(account, targetProfile, offered, requested, tx);
    return STATUS_OK;
  });

  if (status !== STATUS_OK) return status;
  enqueueLiveMail(targetProfile.networkUid, MAIL_TYPE_SECUREECHANGE_OK);
  return STATUS_OK;
}

async function hasIngredientStock(networkUid: string, ingredientId: number, tx: any = prisma): Promise<boolean> {
  const row = await tx.ingredientInventory.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: profileKey(networkUid), globalItemId: ingredientId } },
    select: { number: true },
  });
  return (row?.number ?? 0) > 0;
}

function readStoredNumberArray(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

// Reads/writes an ingredient count with a floor of 0, deleting empty non-locked rows.
async function adjustIngredient(tx: any, networkUid: string, ingredientId: number, delta: number, lockReceived = false): Promise<void> {
  const profileId = profileKey(networkUid);
  const existing = await tx.ingredientInventory.findUnique({
    where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: ingredientId } },
  });
  const next = Math.max(0, (existing?.number ?? 0) + delta);

  if (next === 0 && !existing?.isLocked) {
    if (existing) {
      await tx.ingredientInventory.deleteMany({ where: { userProfileId: profileId, globalItemId: ingredientId } });
    }
    return;
  }

  await tx.ingredientInventory.upsert({
    where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: ingredientId } },
    update: { number: next, ...(lockReceived ? { isLocked: true } : {}) },
    create: { id: ingredientKey(networkUid, ingredientId), userProfileId: profileId, globalItemId: ingredientId, number: next, isLocked: lockReceived },
  });
}

async function deliverTradeConfirmation(
  accepter: ActiveAccount,
  offerer: StoredProfile,
  offered: number,
  requested: number,
  tx: any = prisma,
): Promise<void> {
  await tx.mail.create({
    data: {
      senderProfileId: profileKey(accepter.networkUid),
      recipientProfileId: profileKey(offerer.networkUid),
      senderNetwork: FACEBOOK_NETWORK,
      senderNetworkUid: accepter.networkUid,
      senderPlayfishUid: accepter.playfishUid,
      recipientNetwork: offerer.network || FACEBOOK_NETWORK,
      recipientNetworkUid: offerer.networkUid,
      recipientPlayfishUid: offerer.playfishUid,
      globalItemIdsJson: JSON.stringify([offered, requested]),
      itemId: 0,
      message: '',
      sendDate: nowSeconds(),
      deleteTime: 0,
      type: MAIL_TYPE_SECUREECHANGE_OK,
    },
  });
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

// Answering the daily quiz. `quizId` is the quiz mail id, `answer` the chosen
// reward ingredient's hash, `correct` whether the answer was right.
//
// Matches the PlayFish client: WorldQuiz applies the reward CLIENT-side — it adds
// the reward ingredient (locked, so it persists via saveProfile) and this build
// forces the coin reward to 0 (RpcReplyQuiz zeroes it). So the server grants
// nothing (doing so would double the ingredient); it only consumes the quiz mail
// so it can't be answered twice, and returns the unchanged coin balance.
export async function replyQuiz(account: ActiveAccount, quizId: number, answer: string, correct: boolean): Promise<number> {
  const profile = await ensureAccountProfile(account);

  if (quizId > 0) {
    await prisma.mail.updateMany({
      where: { id: quizId, recipientProfileId: profileKey(account.networkUid) },
      data: { deleted: true },
    });
  }

  await prisma.gameEvent.create({
    data: {
      userProfileId: profileKey(account.networkUid),
      eventType: 25,
      eventText: JSON.stringify({ quizId, answer, correct }),
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

// The stock client only used this as a keep-alive. Our rebuilt SWF registers a
// small game-specific alert event so admins can push live messages to online users.
// Returning zero events here is therefore the correct, complete behaviour.
export async function pollEvents(account: ActiveAccount, request: PollRequest): Promise<{ minPollInterval: number; requestTimeout: number; events: readonly LiveEvent[] }> {
  await ensureAccountProfile(account);
  touchOnline(account);
  const events = pollLiveEvents(account, request.ackEventIds);
  const requestTimeout = boundedInt(request.requestTimeout, 5000, 120000, 30000);
  return {
    minPollInterval: request.synchronous ? 30000 : 5000,
    requestTimeout,
    events,
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
