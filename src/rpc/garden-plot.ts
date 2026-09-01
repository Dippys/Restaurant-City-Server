import * as fs from 'node:fs';
import * as path from 'node:path';

const ITEM_TAG = /<item\b([^>]*)\/?>/g;
let cachedPlantableIds: ReadonlySet<number> | null = null;

export interface GardenIngredient {
  readonly id: number;
  readonly rarity: 1 | 2 | 3 | 4 | 5;
}

/** Garden-only ingredients backed by grown-plant movie clips in indoor_asset.swf. */
export const GARDEN_INGREDIENTS: readonly GardenIngredient[] = [
  { id: 4000003, rarity: 1 }, // Bayleaf
  { id: 4000015, rarity: 1 }, // Garlic
  { id: 4000058, rarity: 1 }, // Coriander
  { id: 4000000, rarity: 2 }, // Basil
  { id: 4000056, rarity: 2 }, // Oregano
  { id: 4000038, rarity: 3 }, // Sugar
  { id: 4000051, rarity: 3 }, // Tea Leaves
  { id: 4000053, rarity: 3 }, // Coffee Beans
  { id: 4000054, rarity: 3 }, // Ginger
  { id: 4000057, rarity: 3 }, // Wasabi
  { id: 4000055, rarity: 4 }, // Vanilla
  { id: 4000046, rarity: 5 }, // Saffron
] as const;

type RarityWeights = readonly [number, number, number, number, number];

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

/** Rarity odds progress with the same level bands that unlock more garden plots. */
export function gardenRarityWeightsForLevel(level: number): RarityWeights {
  const safeLevel = Number.isInteger(level) ? level : 1;
  if (safeLevel >= 32) return [25, 25, 32, 15, 3];
  if (safeLevel >= 28) return [35, 30, 30, 5, 0];
  if (safeLevel >= 22) return [50, 35, 15, 0, 0];
  if (safeLevel >= 13) return [70, 30, 0, 0, 0];
  return [100, 0, 0, 0, 0];
}

/** Select a level-appropriate renderable plant when seedPlant omits the crop id. */
export function gardenIngredientForSeed(
  playerLevel: number,
  random: () => number = Math.random,
  plantableIds: ReadonlySet<number> = shippedPlantableIngredientIds(),
): number {
  const weights = gardenRarityWeightsForLevel(playerLevel);
  const candidates = weights
    .map((weight, index) => ({
      rarity: index + 1,
      weight,
      ingredients: GARDEN_INGREDIENTS.filter((ingredient) => ingredient.rarity === index + 1 && plantableIds.has(ingredient.id)),
    }))
    .filter((tier) => tier.weight > 0 && tier.ingredients.length > 0);
  const totalWeight = candidates.reduce((sum, tier) => sum + tier.weight, 0);
  if (totalWeight <= 0) return 0;

  const rarityRoll = boundedRandom(random()) * totalWeight;
  let selectedTier = candidates[candidates.length - 1];
  let cumulativeWeight = 0;
  for (const tier of candidates) {
    cumulativeWeight += tier.weight;
    if (rarityRoll < cumulativeWeight) {
      selectedTier = tier;
      break;
    }
  }

  const ingredientIndex = Math.floor(boundedRandom(random()) * selectedTier.ingredients.length);
  return selectedTier.ingredients[ingredientIndex]?.id ?? selectedTier.ingredients[0]?.id ?? 0;
}

function boundedRandom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1 - Number.EPSILON, Math.max(0, value));
}

/** Wire id 0 means an empty plot. It is safe even for corrupt legacy rows. */
export function safeGardenIngredientId(
  ingredientId: number,
  plantableIds: ReadonlySet<number> = shippedPlantableIngredientIds(),
): number {
  return plantableIds.has(ingredientId) ? ingredientId : 0;
}
