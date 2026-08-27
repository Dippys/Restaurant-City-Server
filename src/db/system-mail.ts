import { prisma } from './client';
import {
  FACEBOOK_NETWORK,
  PLAYER_NETWORK_UID,
  SYSTEM_NETWORK_UID,
  SYSTEM_SENDER,
  DAILY_INGREDIENT_POOL,
} from './defaults';
import { dailyBonusIngredientIds } from './ingredient-catalog';
import type { ActiveAccount } from '../session';
import { enqueueLiveMail } from '../live-events';

// Client mail type ids (see com.playfish.rpc.cooking.RpcClient in the SWF).
const MAIL_TYPE_QUIZZ = 2;
const MAIL_TYPE_DAILYINGREDIENT = 5;

// The daily-bonus streak grants 1..5 ingredients on consecutive days, then cycles
// (DailyBonusPopUp reads consecutionCount for its "N days" label; the reward count
// and contents come from this mail's globalItemIds — the client grants nothing).
const DAILY_STREAK_CYCLE = 5;
const NPC_RANK_MIN = 3;
const NPC_RANK_MAX = 5;

type SenderIdentity = {
  readonly networkUid: string;
  readonly playfishUid: number;
};

function profileKey(networkUid: string): string {
  return `facebook:${networkUid || PLAYER_NETWORK_UID}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayKey(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function itemType(itemId: number): number {
  return Math.floor(itemId / 1000000);
}

// Grants a mail-delivered item to the recipient's stored profile. Received gift
// and daily-bonus items are NOT added by the PlayFish client on open (it only
// displays them), and profile saves are delta-based, so the server must persist
// the item itself. Ingredients (4xxxxxx) land in the ingredient inventory; other
// items (decor/furniture 2xxxxxx/3xxxxxx, recipes 5xxxxxx) in the item inventory.
export async function grantMailItem(recipientNetworkUid: string, itemId: number): Promise<void> {
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return;
  }
  const profileId = profileKey(recipientNetworkUid);

  if (itemType(itemId) === 4) {
    // Received ingredients start locked so they cannot be traded away until the
    // owner unlocks them (matching the client's receive-lock behaviour).
    await prisma.ingredientInventory.upsert({
      where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: itemId } },
      update: { number: { increment: 1 }, isLocked: true },
      create: { id: `${profileId}:ingredient:${itemId}`, userProfileId: profileId, globalItemId: itemId, number: 1, isLocked: true },
    });
    return;
  }

  await prisma.inventoryItem.upsert({
    where: { userProfileId_globalItemId: { userProfileId: profileId, globalItemId: itemId } },
    update: { number: { increment: 1 } },
    create: { id: `${profileId}:inventory:${itemId}`, userProfileId: profileId, globalItemId: itemId, number: 1, isSelected: false },
  });
}

// The "Restaurant City" system sender used for the daily quiz and daily-bonus mail.
export async function ensureSystemProfile(): Promise<void> {
  await prisma.userProfile.upsert({
    where: { id: profileKey(SYSTEM_NETWORK_UID) },
    update: {},
    create: {
      id: profileKey(SYSTEM_NETWORK_UID),
      network: FACEBOOK_NETWORK,
      networkUid: SYSTEM_NETWORK_UID,
      playfishUid: SYSTEM_SENDER.playfishUid,
      firstName: SYSTEM_SENDER.firstName,
      fullName: SYSTEM_SENDER.fullName,
      restaurantName: SYSTEM_SENDER.restaurantName,
      playCount: 1,
    },
  });
}

interface DeliverMailParams {
  readonly sender: SenderIdentity;
  readonly recipient: ActiveAccount;
  readonly type: number;
  readonly globalItemIds?: readonly number[];
  readonly itemId?: number;
  readonly message?: string;
}

async function deliverMail(params: DeliverMailParams): Promise<void> {
  const recipientUid = params.recipient.networkUid || PLAYER_NETWORK_UID;
  await prisma.mail.create({
    data: {
      senderProfileId: profileKey(params.sender.networkUid),
      recipientProfileId: profileKey(recipientUid),
      senderNetwork: FACEBOOK_NETWORK,
      senderNetworkUid: params.sender.networkUid,
      senderPlayfishUid: params.sender.playfishUid,
      recipientNetwork: FACEBOOK_NETWORK,
      recipientNetworkUid: recipientUid,
      recipientPlayfishUid: params.recipient.playfishUid,
      globalItemIdsJson: JSON.stringify(params.globalItemIds ?? []),
      itemId: params.itemId ?? 0,
      message: params.message ?? '',
      sendDate: nowSeconds(),
      deleteTime: 0,
      type: params.type,
    },
  });
  enqueueLiveMail(recipientUid, params.type);
}

// Records that a given once-per-day grant has happened. Returns true only the
// first time it is called for (player, kind, day) — the effect should run then.
async function claimDailyGrant(recipientProfileId: string, kind: string, dayKey: string): Promise<boolean> {
  try {
    await prisma.systemGrant.create({
      data: { id: `${recipientProfileId}:${kind}:${dayKey}`, userProfileId: recipientProfileId, kind, dayKey, createdAtUnix: nowSeconds() },
    });
    return true;
  } catch {
    // Unique (userProfileId, kind, dayKey) violation => already granted today.
    return false;
  }
}

async function grantExists(recipientProfileId: string, kind: string, dayKey: string): Promise<boolean> {
  const found = await prisma.systemGrant.findUnique({
    where: { userProfileId_kind_dayKey: { userProfileId: recipientProfileId, kind, dayKey } },
  });
  return found !== null;
}

// Delivers an explicit NPC response gift. This is not part of daily login
// content: generating one there produced a second ingredient reward whose
// synthetic UID 1 sender cannot be rendered as a social friend by the client.
export async function sendNpcGift(recipient: ActiveAccount, _npcNetworkUid?: string): Promise<void> {
  await ensureSystemProfile();
  const npcProfile = _npcNetworkUid
    ? await prisma.userProfile.findUnique({ where: { id: profileKey(_npcNetworkUid) }, select: { networkUid: true, playfishUid: true } })
    : null;
  const sender = npcProfile
    ? { networkUid: npcProfile.networkUid, playfishUid: npcProfile.playfishUid }
    : SYSTEM_SENDER;
  const giftIngredient = dailyBonusIngredientIds(1)[0] ?? pick(DAILY_INGREDIENT_POOL);
  await deliverMail({
    sender,
    recipient,
    type: 4,
    globalItemIds: [giftIngredient],
    message: '',
  });
  await grantMailItem(recipient.networkUid, giftIngredient);
}

// Idempotently generates all once-per-day server content for a player: the daily
// quiz mail, the daily free-ingredient bonus, and an occasional NPC
// rank. Safe to call on every init/getMails — grants fire at most once per day.
export async function ensureDailyContent(account: ActiveAccount): Promise<void> {
  await ensureSystemProfile();
  const recipientProfileId = profileKey(account.networkUid || PLAYER_NETWORK_UID);
  const dayKey = todayKey();

  if (await claimDailyGrant(recipientProfileId, 'quiz', dayKey)) {
    await deliverMail({ sender: SYSTEM_SENDER, recipient: account, type: MAIL_TYPE_QUIZZ });
  }

  if (await claimDailyGrant(recipientProfileId, 'dailyIngredient', dayKey)) {
    // Streak: continue if yesterday was claimed, else restart. consecutionCount is
    // the 0-based streak index the client renders as "N+1 days"; reward count cycles
    // 1..5 (index % 5 + 1). The server owns consecutionCount (the client never saves it).
    const profile = await prisma.userProfile.findUnique({ where: { id: recipientProfileId }, select: { consecutionCount: true } });
    const continued = await grantExists(recipientProfileId, 'dailyIngredient', yesterdayKey());
    const streakIndex = continued ? (profile?.consecutionCount ?? 0) + 1 : 0;
    const rewardCount = (streakIndex % DAILY_STREAK_CYCLE) + 1;
    const bonus = dailyBonusIngredientIds(rewardCount);

    await prisma.userProfile.update({ where: { id: recipientProfileId }, data: { consecutionCount: streakIndex } });
    await deliverMail({ sender: SYSTEM_SENDER, recipient: account, type: MAIL_TYPE_DAILYINGREDIENT, globalItemIds: bonus });
    for (const ingredientId of bonus) {
      await grantMailItem(account.networkUid, ingredientId);
    }
  }

  if (await claimDailyGrant(recipientProfileId, 'npcRank', dayKey)) {
    const rating = NPC_RANK_MIN + Math.floor(Math.random() * (NPC_RANK_MAX - NPC_RANK_MIN + 1));
    await prisma.userProfile.update({
      where: { id: recipientProfileId },
      data: { nbVote: { increment: 1 }, totalMark: { increment: rating } },
    });
  }
}
