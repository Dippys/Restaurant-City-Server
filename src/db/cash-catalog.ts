import * as fs from 'node:fs';
import * as path from 'node:path';

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

function attribute(tag: string, key: string): string {
  const match = tag.match(new RegExp(`\\b${key}="([^"]*)"`));
  return match ? match[1] : '';
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function catalogByToken(): ReadonlyMap<string, CashCatalogEntry> {
  if (cachedByToken) return cachedByToken;

  const entries = new Map<string, CashCatalogEntry>();
  const dataDir = path.resolve(__dirname, '..', '..', 'public', 'data');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dataDir).filter((file) => file.endsWith('.xml'));
  } catch {
    cachedByToken = entries;
    return entries;
  }

  for (const file of files) {
    const xml = fs.readFileSync(path.join(dataDir, file), 'utf8');
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
        source: file,
      });
    }
  }

  cachedByToken = entries;
  return entries;
}

/** Resolves an owned-item purchase and rejects a valid token used for a different item id. */
export function ownedItemCashCost(token: string, globalItemId: number): number | null {
  const entry = catalogByToken().get(token);
  return entry && entry.id === globalItemId ? entry.cash : null;
}

/** Ingredient purchase tokens are hashes from ingredient.xml; costs are additive. */
export function ingredientCashCost(tokens: readonly string[]): number | null {
  if (tokens.length === 0) return null;
  let total = 0;
  for (const token of tokens) {
    const entry = catalogByToken().get(token);
    if (!entry || entry.source !== 'ingredient.xml') return null;
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
