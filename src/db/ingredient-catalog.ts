import { INGREDIENTS, type IngredientEntry } from './ingredient-data';

// The client's fixed rarity distribution (WorldQuiz.INGREDIENTS_RARITY_WEIGHT and
// the daily-bonus roll): index 0 => rarity 1 ... index 4 => rarity 5.
const RARITY_WEIGHTS = [50, 30, 15, 5, 1] as const;

const BY_HASH = new Map<string, IngredientEntry>(INGREDIENTS.map((i) => [i.hash, i]));
const BY_ID = new Map<number, IngredientEntry>(INGREDIENTS.map((i) => [i.id, i]));

// Resolves an ingredient token to its numeric id. The client sends the opaque
// `hash` (e.g. "3U1YuPCFbYYkyDirmWQpva") for trades, so hash lookup comes first;
// a numeric token (or one embedding the id) is accepted as a fallback.
export function resolveIngredientId(token: string, fallback: number): number {
  const byHash = BY_HASH.get(token);
  if (byHash) {
    return byHash.id;
  }
  const digits = String(token).match(/\d{6,}/);
  if (digits) {
    const id = Number.parseInt(digits[0], 10);
    if (BY_ID.has(id)) {
      return id;
    }
  }
  return fallback;
}

// Rolls a rarity 1..5 using the client weights, then returns a random ingredient
// of that rarity from `pool`. Falls back through nearby rarities if a tier is
// empty so a pick is always produced.
function rarityWeightedPick(pool: readonly IngredientEntry[], rand: () => number): IngredientEntry | undefined {
  if (pool.length === 0) {
    return undefined;
  }
  const total = RARITY_WEIGHTS.reduce((a, b) => a + b, 0);
  let roll = rand() * total;
  let rarity = 1;
  for (let i = 0; i < RARITY_WEIGHTS.length; i += 1) {
    if (roll < RARITY_WEIGHTS[i]!) {
      rarity = i + 1;
      break;
    }
    roll -= RARITY_WEIGHTS[i]!;
  }
  for (let spread = 0; spread < RARITY_WEIGHTS.length; spread += 1) {
    for (const r of [rarity - spread, rarity + spread]) {
      const tier = pool.filter((i) => i.rarity === r);
      if (tier.length > 0) {
        return tier[Math.floor(rand() * tier.length)];
      }
    }
  }
  return pool[Math.floor(rand() * pool.length)];
}

const DAILY_POOL = INGREDIENTS.filter((i) => !i.noDaily);
const FIRST_VISIT_POOL = INGREDIENTS.filter((i) => !i.noFirstTimeVisit);

// `count` distinct rarity-weighted ingredient ids for a daily-bonus mail, drawn
// from ingredients not flagged noDaily (matches the client's daily eligibility).
export function dailyBonusIngredientIds(count: number, rand: () => number = Math.random): number[] {
  const remaining = [...DAILY_POOL];
  const out: number[] = [];
  while (out.length < count && remaining.length > 0) {
    const pick = rarityWeightedPick(remaining, rand);
    if (!pick) {
      break;
    }
    out.push(pick.id);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return out;
}

// A single rarity-weighted first-visit gift ingredient id (not flagged
// noFirstTimeVisit).
export function firstVisitIngredientId(rand: () => number = Math.random): number {
  return rarityWeightedPick(FIRST_VISIT_POOL, rand)?.id ?? FIRST_VISIT_POOL[0]?.id ?? 4000001;
}
