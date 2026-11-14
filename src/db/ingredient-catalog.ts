// Ingredient catalog for reward rolls (quiz rewards, daily bonus, first-visit
// gift). ADR-0041: rarity / noDaily / noFirstTimeVisit / noQuiz flags are read
// from the DB-backed ingredient.xml (admin edits win), falling back to the
// verified static snapshot in ingredient-data.ts when the file is unavailable.
// The client's fixed rarity distribution (WorldQuiz.INGREDIENTS_RARITY_WEIGHT
// and the daily-bonus roll): index 0 => rarity 1 ... index 4 => rarity 5.
import { gameDataRevision, readDataXml } from './game-data-store';
import { INGREDIENTS, type IngredientEntry } from './ingredient-data';

const RARITY_WEIGHTS = [50, 30, 15, 5, 1] as const;

const ITEM_TAG = /<item\b([^>]*)\/?>/g;

function attribute(tag: string, key: string): string {
  const match = tag.match(new RegExp(`\\b${key}="([^"]*)"`));
  return match ? match[1] : '';
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function snapshotFromXml(xml: string): IngredientEntry[] {
  const entries: IngredientEntry[] = [];
  for (const match of xml.matchAll(ITEM_TAG)) {
    const id = Number(attribute(match[1], 'id'));
    const hash = attribute(match[1], 'hash');
    const rarity = Number(attribute(match[1], 'rarity'));
    if (!Number.isInteger(id) || !hash || !Number.isInteger(rarity) || rarity < 1) continue;
    entries.push({
      id,
      hash,
      rarity,
      noDaily: attribute(match[1], 'noDaily') === 'true',
      noFirstTimeVisit: attribute(match[1], 'noFirstTimeVisit') === 'true',
      noQuiz: attribute(match[1], 'noQuiz') === 'true',
    });
  }
  return entries;
}

let cachedEntries: readonly IngredientEntry[] | null = null;
let cachedRevision = -1;

function ingredientEntries(): readonly IngredientEntry[] {
  const revision = gameDataRevision();
  if (cachedEntries && cachedRevision === revision) return cachedEntries;
  cachedRevision = revision;
  try {
    const xml = readDataXml('ingredient');
    const fromXml = snapshotFromXml(xml);
    if (fromXml.length > 0) {
      cachedEntries = fromXml;
      return cachedEntries;
    }
  } catch {
    // fall through to the static snapshot
  }
  cachedEntries = INGREDIENTS;
  return cachedEntries;
}

let byHash: ReadonlyMap<string, IngredientEntry> | null = null;
let byId: ReadonlyMap<number, IngredientEntry> | null = null;
let indexRevision = -1;

function index(): { byHash: ReadonlyMap<string, IngredientEntry>; byId: ReadonlyMap<number, IngredientEntry> } {
  const revision = gameDataRevision();
  if (byHash && byId && indexRevision === revision) {
    return { byHash, byId };
  }
  indexRevision = revision;
  const entries = ingredientEntries();
  byHash = new Map(entries.map((i) => [i.hash, i]));
  byId = new Map(entries.map((i) => [i.id, i]));
  return { byHash, byId };
}

// Resolves an ingredient token to its numeric id. The client sends the opaque
// `hash` (e.g. "3U1YuPCFbYYkyDirmWQpva") for trades, so hash lookup comes first;
// a numeric token (or one embedding the id) is accepted as a compatibility
// fallback. Unknown values stay invalid instead of becoming a fixed ingredient.
export function resolveIngredientId(token: string): number | null {
  const { byHash, byId } = index();
  const byHashEntry = byHash.get(token);
  if (byHashEntry) {
    return byHashEntry.id;
  }
  const digits = String(token).match(/\d{6,}/);
  if (digits) {
    const id = Number.parseInt(digits[0], 10);
    if (byId.has(id)) {
      return id;
    }
  }
  return null;
}

export function ingredientRarity(id: number): number | null {
  return index().byId.get(id)?.rarity ?? null;
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

function dailyPool(): readonly IngredientEntry[] {
  return ingredientEntries().filter((i) => !i.noDaily);
}

function firstVisitPool(): readonly IngredientEntry[] {
  return ingredientEntries().filter((i) => !i.noFirstTimeVisit);
}

// `count` distinct rarity-weighted ingredient ids for a daily-bonus mail, drawn
// from ingredients not flagged noDaily (matches the client's daily eligibility).
export function dailyBonusIngredientIds(count: number, rand: () => number = Math.random): number[] {
  const remaining = [...dailyPool()];
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
  return rarityWeightedPick(firstVisitPool(), rand)?.id ?? firstVisitPool()[0]?.id ?? 4000001;
}
