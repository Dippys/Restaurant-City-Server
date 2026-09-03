import { captureProfileSnapshotTx } from '../moderation/snapshots';
import { prisma } from './client';

const REPAIR_MARKER_ID = 'migration:legacy-admin-coin-mail-rewards-v1';
const MAX_CREDITS = 2_147_483_647;

export interface LegacyCoinMailRepairResult {
  readonly profiles: number;
  readonly mails: number;
  readonly credits: number;
}

function coinAmount(message: string): number {
  if (!/^\d+$/.test(message)) return 0;
  const amount = Number(message);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 999_999_999 ? amount : 0;
}

/**
 * Credits type-7 coin mail created before coin rewards were funded at send
 * time. This runs before the HTTP server begins accepting new mail. A single
 * transaction and durable marker make the database-wide migration idempotent.
 */
export async function repairLegacyAdminCoinMailRewards(): Promise<LegacyCoinMailRepairResult> {
  return prisma.$transaction(async (tx) => {
    const marker = await tx.systemGrant.findUnique({ where: { id: REPAIR_MARKER_ID } });
    if (marker) return { profiles: 0, mails: 0, credits: 0 };

    const mails = (await tx.mail.findMany({
      where: { type: 7, NOT: { message: { startsWith: 'PFC:' } } },
      select: { id: true, recipientProfileId: true, recipientNetworkUid: true, message: true },
      orderBy: { id: 'asc' },
    })).map((mail) => ({ ...mail, amount: coinAmount(mail.message) })).filter((mail) => mail.amount > 0);

    const byProfile = new Map<string, { networkUid: string; amount: number; mailIds: number[] }>();
    for (const mail of mails) {
      const current = byProfile.get(mail.recipientProfileId) ?? {
        networkUid: mail.recipientNetworkUid,
        amount: 0,
        mailIds: [],
      };
      current.amount += mail.amount;
      current.mailIds.push(mail.id);
      byProfile.set(mail.recipientProfileId, current);
    }

    let appliedCredits = 0;
    for (const [userProfileId, reward] of byProfile) {
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userProfileId } });
      await captureProfileSnapshotTx(
        tx,
        reward.networkUid,
        'AUTO_BEFORE_LEGACY_COIN_MAIL_REPAIR',
        `Before crediting ${reward.mailIds.length} historical coin-mail reward(s)`,
      );
      const nextCredits = Math.min(MAX_CREDITS, profile.credits + reward.amount);
      appliedCredits += nextCredits - profile.credits;
      await tx.userProfile.update({ where: { id: userProfileId }, data: { credits: nextCredits } });
    }

    await tx.systemGrant.create({
      data: {
        id: REPAIR_MARKER_ID,
        userProfileId: 'system',
        kind: 'legacyAdminCoinMailRewards',
        dayKey: 'v1',
        createdAtUnix: Math.floor(Date.now() / 1000),
      },
    });
    return { profiles: byProfile.size, mails: mails.length, credits: appliedCredits };
  });
}
