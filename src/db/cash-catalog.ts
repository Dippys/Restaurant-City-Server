// Cash-catalog: resolves purchase tokens (`hash="…"`) from the DB-backed game
// data (ADR-0041 — reads through game-data-store.readDataXml, so admin edits to
// ingredient.xml / restaurant.xml etc. are visible to cash pricing immediately).
import { gameDataRevision, GAME_DATA_FILES, readDataXml } from './game-data-store';

interface CashCatalogEntry {
  readonly id: number;
  readonly token: string;
  readonly cash: number;
  readonly coinPayout: number;
  readonly source: string;
}

export interface CoinBundle {
  readonly cashCost: number;
  readonly coinPayout: number;
}

const ITEM_TAG = /<item\b([^>]*)\/?>/g;
let cachedByToken: ReadonlyMap<string, CashCatalogEntry> | null = null;
let cachedRevision = -1;

function attribute(tag: string, key: string): string {
  const match = tag.match(new RegExp(`\\b${key}="([^"]*)"`));
  return match ? match[1] : '';
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function catalogByToken(): ReadonlyMap<string, CashCatalogEntry> {
  const revision = gameDataRevision();
  if (cachedByToken && cachedRevision === revision) return cachedByToken;
  cachedRevision = revision;

  const entries = new Map<string, CashCatalogEntry>();
  for (const file of GAME_DATA_FILES) {
    let xml: string;
    try {
      xml = readDataXml(file.name);
    } catch {
      continue;
    }
    for (const match of xml.matchAll(ITEM_TAG)) {
      const token = attribute(match[1], 'hash');
      const id = positiveInteger(attribute(match[1], 'id'));
      const cash = positiveInteger(attribute(match[1], 'cash'));
      if (!token || !id || !cash) continue;
      entries.set(token, {
        id,
        token,
        cash,
        coinPayout: positiveInteger(attribute(match[1], 'cost')),
        source: file.name,
      });
    }
  }

  cachedByToken = entries;
  return entries;
}

/** Resolves an owned-item purchase and rejects a valid token used for a different item id. */
export function ownedItemCashCost(token: string, globalItemId: number): number | null {
  const entry = catalogByToken().get(token);
  if (!entry || entry.id !== globalItemId) return null;
  return entry.cash;
}

/** Ingredient purchase tokens are hashes from ingredient.xml; costs are additive. */
export function ingredientCashCost(tokens: readonly string[]): number | null {
  if (tokens.length === 0) return null;
  let total = 0;
  for (const token of tokens) {
    const entry = catalogByToken().get(token);
    if (!entry || entry.source !== 'ingredient') return null;
    total += entry.cash;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Coin conversion entries are the only catalog rows carrying both cash and coin cost values. */
export function coinBundleForToken(token: string): CoinBundle | null {
  const entry = catalogByToken().get(token);
  if (!entry || !entry.coinPayout) return null;
  return { cashCost: entry.cash, coinPayout: entry.coinPayout };
}
