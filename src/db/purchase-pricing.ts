import type { Prisma } from '@prisma/client';
import { coinPriceForItemId } from './item-catalog';
import type { PurchaseAuditData } from './profile-store';

/**
 * Coin price the shipped client charges for planting one garden seed.
 * Spec: decompiled/game/scripts/com/playfish/games/cooking/GardenPlot.as:15
 * (`public static const SEED_COST:int = 2000`). The client deducts it only
 * locally (`WorldPlantSeedPopUp.as:59`) and sends no credit delta, so the
 * server prices it here (ADR-0035).
 */
export const SEED_COST = 2000;

export interface PurchasePricing {
  readonly cost: number;
  /** True when any purchase cannot be priced from authoritative game data. */
  readonly invalid: boolean;
}

/**
 * Sums the authoritative coin price of every purchase recorded in a save
 * audit (ADR-0035). The shipped client never sends purchase credit deltas
 * (`SaveProfileHandler.purchaseItem` audits carry no `creditsDelta`), so the
 * server is the price authority:
 * - owned/inventory/perk purchases: item `cost` from the shipped data XMLs
 *   (`coinPriceForItemId`); cash-only or unknown items are invalid because
 *   legit coin purchases always resolve to a cost-bearing item;
 * - ingredient purchases (action 34): the enabled ingredient-market row the
 *   client displays and charges (`ingredientMarketItems()`), never the XML;
 * - seed planting (action 38): `SEED_COST` per seed.
 */
export async function pricePurchases(
  purchases: readonly PurchaseAuditData[],
  tx: Prisma.TransactionClient,
): Promise<PurchasePricing> {
  let cost = 0;
  for (const purchase of purchases) {
    if (purchase.unresolved) {
      return { cost: 0, invalid: true };
    }
    if (purchase.kind === 'seed') {
      cost += SEED_COST;
      continue;
    }
    if (purchase.kind === 'ingredient') {
      const market = await tx.ingredientMarketItem.findUnique({
        where: { ingredientId: purchase.itemId ?? -1 },
      });
      if (!market || !market.enabled || market.price <= 0) {
        return { cost: 0, invalid: true };
      }
      cost += market.price * Math.max(1, purchase.qty);
      continue;
    }
    const price = coinPriceForItemId(purchase.itemId ?? -1);
    if (price === null) {
      return { cost: 0, invalid: true };
    }
    cost += price * Math.max(1, purchase.qty);
  }
  return { cost, invalid: false };
}
