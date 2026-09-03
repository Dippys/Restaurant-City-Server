import type { Prisma } from '@prisma/client';
import { coinPriceForItemId, itemAttributes, itemIdForToken, sellPriceForItemId } from './item-catalog';
import type { PurchaseAuditData, SaleAuditData } from './profile-store';

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
  /** Item-level reasons retained for operator investigation. */
  readonly issues: readonly PurchasePricingIssue[];
}

export interface PurchasePricingIssue {
  readonly index: number;
  readonly kind: PurchaseAuditData['kind'];
  readonly itemId?: number;
  readonly qty: number;
  readonly token?: string;
  readonly reason: 'unresolved-token' | 'ingredient-not-for-sale' | 'item-not-coin-purchasable' | 'unsafe-cost';
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
  const issues: PurchasePricingIssue[] = [];
  const addIssue = (index: number, purchase: PurchaseAuditData, reason: PurchasePricingIssue['reason']): void => {
    issues.push({
      index,
      kind: purchase.kind,
      itemId: purchase.itemId,
      qty: purchase.qty,
      token: purchase.token,
      reason,
    });
  };
  const addCost = (index: number, purchase: PurchaseAuditData, amount: number): void => {
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(cost + amount)) {
      addIssue(index, purchase, 'unsafe-cost');
      return;
    }
    cost += amount;
  };

  for (const [index, purchase] of purchases.entries()) {
    if (purchase.unresolved) {
      addIssue(index, purchase, 'unresolved-token');
      continue;
    }
    if (purchase.kind === 'seed') {
      addCost(index, purchase, SEED_COST * Math.max(1, purchase.qty));
      continue;
    }
    if (purchase.kind === 'ingredient') {
      const market = await tx.ingredientMarketItem.findUnique({
        where: { ingredientId: purchase.itemId ?? -1 },
      });
      if (!market || !market.enabled || market.price <= 0) {
        addIssue(index, purchase, 'ingredient-not-for-sale');
        continue;
      }
      addCost(index, purchase, market.price * Math.max(1, purchase.qty));
      continue;
    }
    let price = coinPriceForItemId(purchase.itemId ?? -1);
    if (purchase.kind === 'perk') {
      const attrs = itemAttributes(purchase.itemId ?? -1);
      const perkCost = attrs && Object.prototype.hasOwnProperty.call(attrs, 'cost') ? Number(attrs.cost) : Number.NaN;
      price = Number.isInteger(perkCost) && perkCost >= 0 ? perkCost : null;
    }
    if (price === null) {
      addIssue(index, purchase, 'item-not-coin-purchasable');
      continue;
    }
    addCost(index, purchase, price * Math.max(1, purchase.qty));
  }
  return { cost, invalid: issues.length > 0, issues };
}

export interface SalePricing {
  readonly revenue: number;
  readonly invalid: boolean;
}

/**
 * Prices actions 4/19 from shipped data and verifies the player owns exactly
 * what is being sold. The original client adds sale coins locally but writes
 * neither `newCredits` nor `creditsDelta` into these audit rows.
 */
export async function priceSales(
  sales: readonly SaleAuditData[],
  userProfileId: string,
  tx: Prisma.TransactionClient,
): Promise<SalePricing> {
  let revenue = 0;
  const seenOwned = new Set<number>();
  const inventoryRequired = new Map<number, number>();

  for (const sale of sales) {
    if (!Number.isSafeInteger(sale.qty) || sale.qty < 1 || itemIdForToken(sale.token) !== sale.itemId) {
      return { revenue: 0, invalid: true };
    }
    const unitPrice = sellPriceForItemId(sale.itemId);
    if (unitPrice === null) return { revenue: 0, invalid: true };

    if (sale.kind === 'owned') {
      if (sale.qty !== 1 || !Number.isSafeInteger(sale.serverId) || seenOwned.has(sale.serverId!)) {
        return { revenue: 0, invalid: true };
      }
      seenOwned.add(sale.serverId!);
      const row = await tx.ownedItem.findUnique({
        where: { userProfileId_serverId: { userProfileId, serverId: sale.serverId! } },
        select: { globalItemId: true },
      });
      if (row?.globalItemId !== sale.itemId) return { revenue: 0, invalid: true };
    } else {
      inventoryRequired.set(sale.itemId, (inventoryRequired.get(sale.itemId) ?? 0) + sale.qty);
    }

    revenue += unitPrice * sale.qty;
    if (!Number.isSafeInteger(revenue)) return { revenue: 0, invalid: true };
  }

  for (const [globalItemId, required] of inventoryRequired) {
    const row = await tx.inventoryItem.findUnique({
      where: { userProfileId_globalItemId: { userProfileId, globalItemId } },
      select: { number: true },
    });
    if ((row?.number ?? 0) < required) return { revenue: 0, invalid: true };
  }

  return { revenue, invalid: false };
}
