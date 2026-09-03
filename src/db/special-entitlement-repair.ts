import { captureProfileSnapshotTx } from '../moderation/snapshots';
import { isNonEditableRestaurantEntitlementItem, itemAttributes } from './item-catalog';
import { prisma } from './client';

export interface SpecialEntitlementRepairResult {
  readonly profiles: number;
  readonly restoredItems: number;
  readonly removedInventoryUnits: number;
  readonly refundedCoins: number;
  readonly refundedCash: number;
}

const MAX_CREDITS = 2_147_483_647;

function ownedItemKey(networkUid: string, serverId: number): string {
  return `facebook:${networkUid}:owned:${serverId}`;
}

function positivePrice(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Repairs ownership rows that the old action-51 implementation incorrectly
 * moved into ordinary inventory. These groups are separate GameUser
 * collections in the shipped client and can never legitimately be inventory.
 * One ownership row is restored per item id; repeated re-purchases are
 * refunded in their original currency. Deleting the bad inventory row is the
 * durable idempotency marker.
 */
export async function repairMisclassifiedRestaurantEntitlements(): Promise<SpecialEntitlementRepairResult> {
  const candidates = (await prisma.inventoryItem.findMany({
    where: {
      number: { gt: 0 },
      OR: [
        { globalItemId: { gte: 3_600_000, lt: 3_610_000 } },
        { globalItemId: { gte: 3_900_000, lt: 3_920_000 } },
      ],
    },
    select: { userProfileId: true },
    distinct: ['userProfileId'],
  })).map((row) => row.userProfileId);

  const totals = { profiles: 0, restoredItems: 0, removedInventoryUnits: 0, refundedCoins: 0, refundedCash: 0 };
  for (const userProfileId of candidates) {
    const repaired = await prisma.$transaction(async (tx) => {
      const inventory = (await tx.inventoryItem.findMany({
        where: { userProfileId, number: { gt: 0 } },
        orderBy: { globalItemId: 'asc' },
      })).filter((row) => isNonEditableRestaurantEntitlementItem(row.globalItemId));
      if (inventory.length === 0) return null;

      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userProfileId } });
      await captureProfileSnapshotTx(
        tx,
        profile.networkUid,
        'AUTO_BEFORE_SPECIAL_ENTITLEMENT_REPAIR',
        `Before restoring ${inventory.length} misclassified restaurant entitlement row(s)`,
      );

      const itemIds = inventory.map((row) => row.globalItemId);
      const owned = await tx.ownedItem.findMany({
        where: { userProfileId, globalItemId: { in: itemIds } },
        select: { globalItemId: true },
      });
      const ownedIds = new Set(owned.map((row) => row.globalItemId));
      const maxOwned = await tx.ownedItem.findFirst({
        where: { userProfileId, serverId: { gt: 0 } },
        orderBy: { serverId: 'desc' },
        select: { serverId: true },
      });
      let nextServerId = (maxOwned?.serverId ?? 0) + 1;
      let restoredItems = 0;
      let removedInventoryUnits = 0;
      let refundedCoins = 0;
      let refundedCash = 0;

      for (const row of inventory) {
        const restoreOne = !ownedIds.has(row.globalItemId);
        if (restoreOne) {
          await tx.ownedItem.create({
            data: {
              id: ownedItemKey(profile.networkUid, nextServerId),
              userProfileId,
              serverId: nextServerId,
              globalItemId: row.globalItemId,
              positionX: 0,
              positionY: 0,
              data: 0,
              roomIndex: 0,
              employeeNetwork: 0,
              employeeNetworkUid: '',
              employeePlayfishUid: 0,
            },
          });
          nextServerId += 1;
          restoredItems += 1;
        }

        const duplicateUnits = Math.max(0, row.number - (restoreOne ? 1 : 0));
        const attributes = itemAttributes(row.globalItemId);
        const cashPrice = positivePrice(attributes?.cash);
        if (cashPrice > 0) refundedCash += cashPrice * duplicateUnits;
        else refundedCoins += positivePrice(attributes?.cost) * duplicateUnits;
        removedInventoryUnits += row.number;
        await tx.inventoryItem.delete({ where: { id: row.id } });
      }

      const nextCredits = Math.min(MAX_CREDITS, profile.credits + refundedCoins);
      const appliedCoinRefund = nextCredits - profile.credits;
      if (appliedCoinRefund > 0 || refundedCash > 0) {
        await tx.userProfile.update({
          where: { id: userProfileId },
          data: {
            ...(appliedCoinRefund > 0 ? { credits: nextCredits } : {}),
            ...(refundedCash > 0 ? { cashBalance: { increment: refundedCash } } : {}),
          },
        });
      }
      if (refundedCash > 0) {
        await tx.cashTransaction.create({
          data: {
            userProfileId,
            kind: 'repairMisclassifiedEntitlements',
            token: itemIds.join(','),
            amount: refundedCash,
            balanceAfter: profile.cashBalance + refundedCash,
            createdAtUnix: Math.floor(Date.now() / 1000),
          },
        });
      }

      return { restoredItems, removedInventoryUnits, refundedCoins: appliedCoinRefund, refundedCash };
    });

    if (!repaired) continue;
    totals.profiles += 1;
    totals.restoredItems += repaired.restoredItems;
    totals.removedInventoryUnits += repaired.removedInventoryUnits;
    totals.refundedCoins += repaired.refundedCoins;
    totals.refundedCash += repaired.refundedCash;
  }
  return totals;
}
