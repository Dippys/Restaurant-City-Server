import { ingredientIdForCashToken } from './cash-catalog';
import { prisma } from './client';
import { captureProfileSnapshotTx } from '../moderation/snapshots';

export const LEGACY_CASH_INGREDIENT_KIND = 'purchaseCashItemIngredients';
export const CURRENT_CASH_INGREDIENT_KIND = 'purchaseCashItemIngredientsV2';
export const REPAIRED_CASH_INGREDIENT_KIND = 'purchaseCashItemIngredientsRepaired';

export interface LegacyCashIngredientRepairResult {
  readonly profiles: number;
  readonly transactions: number;
  readonly purchasedUnits: number;
  readonly adjustedRows: number;
  readonly skippedTransactions: number;
}

/** Reproduces the faulty pre-ADR-0043 token conversion so its credits can be reversed. */
export function legacyIngredientIdFromToken(token: string): number {
  const digits = token.match(/\d+/)?.[0] ?? '';
  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 4_000_000;
}

/**
 * Repairs PF-cash ingredient purchases made before opaque hashes were resolved
 * through ingredient.xml. Each profile is snapshotted and repaired atomically;
 * changing the transaction kind is the durable idempotency marker.
 */
export async function repairLegacyCashIngredientPurchases(): Promise<LegacyCashIngredientRepairResult> {
  const profileGroups = await prisma.cashTransaction.groupBy({
    by: ['userProfileId'],
    where: { kind: LEGACY_CASH_INGREDIENT_KIND },
  });
  const totals = { profiles: 0, transactions: 0, purchasedUnits: 0, adjustedRows: 0, skippedTransactions: 0 };

  for (const { userProfileId } of profileGroups) {
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.cashTransaction.findMany({
        where: { userProfileId, kind: LEGACY_CASH_INGREDIENT_KIND },
        select: { id: true, token: true },
        orderBy: { id: 'asc' },
      });
      const transactionIds: number[] = [];
      const deltas = new Map<number, number>();
      let purchasedUnits = 0;
      let skippedTransactions = 0;

      for (const row of rows) {
        const tokens = row.token.split(',').map((token) => token.trim()).filter(Boolean);
        const resolved = tokens.map(ingredientIdForCashToken);
        if (tokens.length === 0 || resolved.some((id) => id === null)) {
          skippedTransactions += 1;
          continue;
        }
        transactionIds.push(row.id);
        purchasedUnits += tokens.length;
        tokens.forEach((token, index) => {
          const correctId = resolved[index] as number;
          const legacyId = legacyIngredientIdFromToken(token);
          if (correctId === legacyId) return;
          deltas.set(correctId, (deltas.get(correctId) ?? 0) + 1);
          deltas.set(legacyId, (deltas.get(legacyId) ?? 0) - 1);
        });
      }

      if (transactionIds.length === 0) {
        return { repaired: false, transactions: 0, purchasedUnits: 0, adjustedRows: 0, skippedTransactions };
      }

      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userProfileId }, select: { networkUid: true } });
      await captureProfileSnapshotTx(
        tx,
        profile.networkUid,
        'AUTO_BEFORE_CASH_INGREDIENT_REPAIR',
        `Before repairing ${transactionIds.length} legacy PF-cash ingredient purchase(s)`,
      );

      let adjustedRows = 0;
      for (const [globalItemId, delta] of deltas) {
        if (delta === 0) continue;
        const current = await tx.ingredientInventory.findUnique({
          where: { userProfileId_globalItemId: { userProfileId, globalItemId } },
        });
        const nextNumber = Math.max(0, (current?.number ?? 0) + delta);
        if (nextNumber === (current?.number ?? 0)) continue;
        adjustedRows += 1;
        if (nextNumber === 0) {
          await tx.ingredientInventory.delete({ where: { userProfileId_globalItemId: { userProfileId, globalItemId } } });
        } else if (current) {
          await tx.ingredientInventory.update({
            where: { userProfileId_globalItemId: { userProfileId, globalItemId } },
            data: { number: nextNumber, ...(delta > 0 ? { isLocked: true } : {}) },
          });
        } else {
          await tx.ingredientInventory.create({
            data: { id: `${userProfileId}:ingredient:${globalItemId}`, userProfileId, globalItemId, number: nextNumber, isLocked: true },
          });
        }
      }

      await tx.cashTransaction.updateMany({
        where: { id: { in: transactionIds }, kind: LEGACY_CASH_INGREDIENT_KIND },
        data: { kind: REPAIRED_CASH_INGREDIENT_KIND },
      });
      return { repaired: true, transactions: transactionIds.length, purchasedUnits, adjustedRows, skippedTransactions };
    });

    if (result.repaired) totals.profiles += 1;
    totals.transactions += result.transactions;
    totals.purchasedUnits += result.purchasedUnits;
    totals.adjustedRows += result.adjustedRows;
    totals.skippedTransactions += result.skippedTransactions;
  }

  return totals;
}
