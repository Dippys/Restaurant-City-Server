import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DailyIngredient {
  readonly id: number;
  readonly name: string;
  readonly pfCash: 4 | 6 | 8;
  readonly coinPrice: 1000 | 1500 | 2000;
}

const PF_TO_COIN_PRICE = new Map<number, DailyIngredient['coinPrice']>([
  [4, 1000],
  [6, 1500],
  [8, 2000],
]);
const ITEM_TAG = /<item\b([^>]*)\/?>/g;
let cachedCatalog: readonly DailyIngredient[] | null = null;

function attribute(tag: string, key: string): string {
  return tag.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1] ?? '';
}

export function coinPriceForPfCash(pfCash: number): DailyIngredient['coinPrice'] | null {
  return PF_TO_COIN_PRICE.get(pfCash) ?? null;
}

/** Coin-market eligible ingredients, derived from the shipped ingredient.xml. */
export function dailyIngredientCatalog(): readonly DailyIngredient[] {
  if (cachedCatalog) return cachedCatalog;
  const xmlPath = path.resolve(__dirname, '..', '..', 'public', 'data', 'ingredient.xml');
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const catalog: DailyIngredient[] = [];

  for (const match of xml.matchAll(ITEM_TAG)) {
    const tag = match[1] ?? '';
    if (attribute(tag, 'noDaily') === 'true' || attribute(tag, 'noCoinShop') === 'true') continue;
    const id = Number(attribute(tag, 'id'));
    const pfCash = Number(attribute(tag, 'cash'));
    const coinPrice = coinPriceForPfCash(pfCash);
    const name = attribute(tag, 'name');
    if (!Number.isSafeInteger(id) || Math.floor(id / 1_000_000) !== 4 || !name || !coinPrice) continue;
    catalog.push({ id, name, pfCash: pfCash as 4 | 6 | 8, coinPrice });
  }

  if (catalog.length < 3) throw new Error('ingredient.xml has fewer than three eligible daily coin-market ingredients.');
  cachedCatalog = catalog;
  return cachedCatalog;
}

export function selectDailyIngredients(
  catalog: readonly DailyIngredient[],
  previousIds: ReadonlySet<number> = new Set(),
  randomIndex: (upperExclusive: number) => number,
): DailyIngredient[] {
  const preferred = catalog.filter((ingredient) => !previousIds.has(ingredient.id));
  const pool = [...(preferred.length >= 3 ? preferred : catalog)];
  const selected: DailyIngredient[] = [];
  while (selected.length < 3) {
    const index = randomIndex(pool.length);
    if (!Number.isInteger(index) || index < 0 || index >= pool.length) throw new Error('Random ingredient index was out of range.');
    selected.push(pool.splice(index, 1)[0]!);
  }
  return selected;
}
