import * as fs from 'node:fs';
import * as path from 'node:path';

const ITEM_TAG = /<item\b([^>]*)\/?>/g;
let cachedPlantableIds: ReadonlySet<number> | null = null;

function attribute(tag: string, key: string): string {
  const match = tag.match(new RegExp(`\\b${key}="([^"]*)"`));
  return match ? match[1] : '';
}

/** Ingredient ids that the Flash client can render as plants. */
export function plantableIngredientIds(xml: string): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const match of xml.matchAll(ITEM_TAG)) {
    const id = Number(attribute(match[1], 'id'));
    const plantClassName = attribute(match[1], 'plantClassName').trim();
    if (Number.isSafeInteger(id) && id > 0 && plantClassName) {
      ids.add(id);
    }
  }
  return ids;
}

function shippedPlantableIngredientIds(): ReadonlySet<number> {
  if (cachedPlantableIds) return cachedPlantableIds;

  const filename = path.resolve(__dirname, '..', '..', 'public', 'data', 'ingredient.xml');
  try {
    cachedPlantableIds = plantableIngredientIds(fs.readFileSync(filename, 'utf8'));
  } catch {
    cachedPlantableIds = new Set<number>();
  }
  return cachedPlantableIds;
}

/** Wire id 0 means an empty plot. It is safe even for corrupt legacy rows. */
export function safeGardenIngredientId(
  ingredientId: number,
  plantableIds: ReadonlySet<number> = shippedPlantableIngredientIds(),
): number {
  return plantableIds.has(ingredientId) ? ingredientId : 0;
}
