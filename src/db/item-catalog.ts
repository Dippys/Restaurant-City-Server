// Full item catalogue for the admin dashboard and server-side pricing, built at
// runtime from the DB-backed game data (ADR-0041: reads through
// game-data-store.readDataXml, which returns the canonical GameDataFile row or
// falls back to the disk XML) plus the hand-curated fallback in defaults.ts.
// Every <item id="…" name="…"/> becomes { id, label, category } so admins can
// work with names instead of ids. Module-level caches are keyed on the store
// revision so admin edits invalidate them.
import { ITEM_CATALOG, type ItemCatalogEntry } from './defaults';
import { gameDataRevision, readDataXml } from './game-data-store';

// Data files that contain item definitions. quiz.xml / challenge.xml /
// model.xml / resconfig.xml / newsletter.xml / lang_*.xml have no <item id name>
// rows and are skipped.
const CATALOG_FILES = [
  'front.xml',
  'restaurant.xml',
  'ingredient.xml',
  'recipe.xml',
  'perk.xml',
  'avatar.xml',
  'appointment.xml',
];

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

function catalogXml(name: string): string {
  return readDataXml(name.replace(/\.xml$/, ''));
}

let cached: readonly ItemCatalogEntry[] | null = null;
let cachedRevision = -1;
let cachedAttributes: ReadonlyMap<number, Readonly<Record<string, string>>> | null = null;
let cachedAttributesRevision = -1;
let cachedOutdoorIds: ReadonlySet<number> | null = null;
let cachedOutdoorRevision = -1;

/** Full catalogue: curated entries first, then every id/name found in the data XMLs (XML names win). */
export function fullCatalog(): readonly ItemCatalogEntry[] {
  const revision = gameDataRevision();
  if (cached && cachedRevision === revision) return cached;
  cachedRevision = revision;

  const byId = new Map<number, ItemCatalogEntry>();
  for (const entry of ITEM_CATALOG) {
    byId.set(entry.id, entry);
  }

  for (const file of CATALOG_FILES) {
    let xml: string;
    try {
      xml = catalogXml(file);
    } catch {
      continue;
    }
    const category = file.replace(/\.xml$/, '');
    for (const match of xml.matchAll(ITEM_TAG)) {
      const id = Number(attribute(match[1], 'id'));
      const name = decodeEntities(attribute(match[1], 'name')).trim();
      if (Number.isInteger(id) && name) {
        byId.set(id, { id, label: name, category });
      }
    }
  }

  cached = [...byId.values()].sort((a, b) => a.id - b.id);
  return cached;
}

export function isCatalogItemId(id: number): boolean {
  return fullCatalog().some((entry) => entry.id === id);
}

let cachedHashIndex: ReadonlyMap<string, number> | null = null;
let cachedHashRevision = -1;

/**
 * Resolves an opaque item hash (the `hash="…"` attribute from the shipped
 * data XMLs, which the client sends as `AuditChange.itemToken`) to its item
 * id. Previously the save parser guessed ids by extracting digits from the
 * hash, which produced stale id-0/1/2/… inventory rows; the hash index is the
 * authoritative mapping (ADR-0035).
 */
export function itemIdForToken(token: string): number | undefined {
  const revision = gameDataRevision();
  if (cachedHashIndex && cachedHashRevision === revision) return cachedHashIndex.get(token);
  cachedHashRevision = revision;
  const byHash = new Map<string, number>();
  for (const file of CATALOG_FILES) {
    let xml = '';
    try { xml = catalogXml(file); } catch { continue; }
    for (const match of xml.matchAll(ITEM_TAG)) {
      const hash = attribute(match[1], 'hash');
      const id = Number(attribute(match[1], 'id'));
      if (hash && Number.isInteger(id)) byHash.set(hash, id);
    }
  }
  cachedHashIndex = byHash;
  return cachedHashIndex.get(token);
}

/**
 * The coin price of an item as the shipped client charges it
 * (`CashPanel.addCoins(-itemConfig.cost)`). Returns `null` when the item is
 * not coin-purchasable through the save audit: unknown ids, cash-only items
 * (PF Cash purchases go through RPC 41/42, never the save audit), and
 * invisible/non-shop rows. Items with `cost="0"` (e.g. the starter avatar
 * outfit) are valid and free. ADR-0035.
 */
export function coinPriceForItemId(id: number): number | null {
  const attrs = itemAttributes(id);
  if (!attrs) return null;
  if (!Object.prototype.hasOwnProperty.call(attrs, 'cost')) return null;
  const cost = Number(attrs.cost);
  return Number.isInteger(cost) && cost >= 0 ? cost : null;
}

/** "Apple (4000000)" label for display, or the raw id if unknown. */
export function catalogLabel(id: number): string {
  const entry = fullCatalog().find((candidate) => candidate.id === id);
  return entry ? `${entry.label} (${id})` : `Unknown item (${id})`;
}

export function catalogEntry(id: number): ItemCatalogEntry | undefined {
  return fullCatalog().find((entry) => entry.id === id);
}

export function itemAttributes(id: number): Readonly<Record<string, string>> | undefined {
  const revision = gameDataRevision();
  if (cachedAttributes && cachedAttributesRevision === revision) return cachedAttributes.get(id);
  cachedAttributesRevision = revision;

  const attributes = new Map<number, Readonly<Record<string, string>>>();
  for (const file of CATALOG_FILES) {
    let xml = '';
    try { xml = catalogXml(file); } catch { continue; }
    for (const match of xml.matchAll(ITEM_TAG)) {
      const values: Record<string, string> = {};
      for (const attr of match[1].matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
        values[attr[1]] = decodeEntities(attr[2]);
      }
      const itemId = Number(values.id);
      if (Number.isInteger(itemId)) attributes.set(itemId, values);
    }
  }
  cachedAttributes = attributes;
  return cachedAttributes.get(id);
}

// The AS3 marks an item `outdoor` through its group `type` string
// (RoomItem.as:154-171 sets flags from group/item types). In the shipped
// restaurant.xml exactly one group declares `type="outdoor"` ("Outdoor Only",
// the 312xxxxx plants/trees), so a placement counts as outdoor decoration iff
// its item id belongs to a group whose `type` attribute contains `outdoor`.
// Used by the Gourmet Street scoring (ADR-0037); the client equivalent is
// ItemCatalog flags in client-html5/src/game/catalog.ts.
const GROUP_BLOCK = /<group\b([^>]*)>([\s\S]*?)<\/group>/g;

export function outdoorItemIds(): ReadonlySet<number> {
  const revision = gameDataRevision();
  if (cachedOutdoorIds && cachedOutdoorRevision === revision) {
    return cachedOutdoorIds;
  }
  cachedOutdoorRevision = revision;

  const ids = new Set<number>();
  let xml: string;
  try {
    xml = readDataXml('restaurant');
  } catch {
    cachedOutdoorIds = ids;
    return ids;
  }
  for (const match of xml.matchAll(GROUP_BLOCK)) {
    if (!/\btype="[^"]*\boutdoor\b[^"]*"/.test(match[1] ?? '')) {
      continue;
    }
    for (const item of (match[2] ?? '').matchAll(ITEM_TAG)) {
      const id = Number(attribute(item[1], 'id'));
      if (Number.isInteger(id)) {
        ids.add(id);
      }
    }
  }

  cachedOutdoorIds = ids;
  return cachedOutdoorIds;
}

export function isOutdoorItemId(globalItemId: number): boolean {
  return outdoorItemIds().has(globalItemId);
}

export function isFoodKingEligibleItem(id: number): boolean {
  return itemAttributes(id)?.foodKingFeed === 'true';
}

export function isEmployeeSnackItem(id: number): boolean {
  const entry = catalogEntry(id);
  if (entry?.category !== 'perk') return false;
  try {
    const xml = readDataXml('perk');
    const group = xml.match(/<group\s+name="Employee">([\s\S]*?)<\/group>/)?.[1] ?? '';
    return new RegExp(`<item\\b[^>]*\\bid="${id}"`).test(group);
  } catch {
    return false;
  }
}
