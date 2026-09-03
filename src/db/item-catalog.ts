// Full item catalogue for the admin dashboard, built at runtime from the
// decompressed data XMLs the server serves (server/public/data/*.xml) plus the
// hand-curated fallback in defaults.ts. Every <item id="…" name="…"/> becomes
// { id, label, category } so admins can work with names instead of ids.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ITEM_CATALOG, type ItemCatalogEntry } from './defaults';

// Data files that contain item definitions. quiz.xml / challenge.xml /
// model.xml / resconfig.xml have no <item id name> rows and are skipped.
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

/**
 * The shipped XML contains retired item rows inside comments. Regex-based
 * catalogue scans must remove those comments first or a retired row with the
 * same id can overwrite the live definition (perk.xml does this for employee
 * snacks 6000000-6000003).
 */
function withoutXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

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

let cached: readonly ItemCatalogEntry[] | null = null;
let cachedAttributes: ReadonlyMap<number, Readonly<Record<string, string>>> | null = null;
let cachedOutdoorIds: ReadonlySet<number> | null = null;
let cachedStackableIds: ReadonlySet<number> | null = null;
let cachedWallDecorationIds: ReadonlySet<number> | null = null;

/** Full catalogue: curated entries first, then every id/name found in the data XMLs (XML names win). */
export function fullCatalog(): readonly ItemCatalogEntry[] {
  if (cached) return cached;

  const byId = new Map<number, ItemCatalogEntry>();
  for (const entry of ITEM_CATALOG) {
    byId.set(entry.id, entry);
  }

  const dataDir = path.resolve(__dirname, '..', '..', 'public', 'data');
  for (const file of CATALOG_FILES) {
    const fullPath = path.join(dataDir, file);
    let xml: string;
    try {
      xml = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    const category = file.replace(/\.xml$/, '');
    for (const match of withoutXmlComments(xml).matchAll(ITEM_TAG)) {
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

/**
 * Resolves an opaque item hash (the `hash="…"` attribute from the shipped
 * data XMLs, which the client sends as `AuditChange.itemToken`) to its item
 * id. Previously the save parser guessed ids by extracting digits from the
 * hash, which produced stale id-0/1/2/… inventory rows; the hash index is the
 * authoritative mapping (ADR-0035).
 */
export function itemIdForToken(token: string): number | undefined {
  if (!cachedHashIndex) {
    const byHash = new Map<string, number>();
    const dataDir = path.resolve(__dirname, '..', '..', 'public', 'data');
    for (const file of CATALOG_FILES) {
      let xml = '';
      try { xml = fs.readFileSync(path.join(dataDir, file), 'utf8'); } catch { continue; }
      for (const match of withoutXmlComments(xml).matchAll(ITEM_TAG)) {
        const hash = attribute(match[1], 'hash');
        const id = Number(attribute(match[1], 'id'));
        if (hash && Number.isInteger(id)) byHash.set(hash, id);
      }
    }
    cachedHashIndex = byHash;
  }
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
  // The save-audit purchase path must never price an invisible/non-shop row:
  // such items cannot be bought in the shop, so a priced purchase would mint
  // an unavailable item for the token's coin cost (e.g. the 3 Million Fans
  // Statue, id 3500093, carries cost="1" while invisible="true").
  if (attrs.invisible === 'true') return null;
  if (!Object.prototype.hasOwnProperty.call(attrs, 'cost')) return null;
  const cost = Number(attrs.cost);
  return Number.isInteger(cost) && cost >= 0 ? cost : null;
}

/** Shipped `GameWorld.getItemSellPrice`: cash × 330, else floor(cost / 3). */
export function sellPriceForItemId(id: number): number | null {
  const attrs = itemAttributes(id);
  if (!attrs) return null;
  const cash = Number(attrs.cash ?? 0);
  if (Number.isInteger(cash) && cash > 0) return cash * 330;
  const cost = Number(attrs.cost);
  return Number.isInteger(cost) && cost >= 0 ? Math.floor(cost / 3) : null;
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
  if (!cachedAttributes) {
    const attributes = new Map<number, Readonly<Record<string, string>>>();
    const dataDir = path.resolve(__dirname, '..', '..', 'public', 'data');
    for (const file of CATALOG_FILES) {
      let xml = '';
      try { xml = fs.readFileSync(path.join(dataDir, file), 'utf8'); } catch { continue; }
      for (const match of withoutXmlComments(xml).matchAll(ITEM_TAG)) {
        const values: Record<string, string> = {};
        for (const attr of match[1].matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
          values[attr[1]] = decodeEntities(attr[2]);
        }
        const itemId = Number(values.id);
        if (Number.isInteger(itemId)) attributes.set(itemId, values);
      }
    }
    cachedAttributes = attributes;
  }
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
  if (cachedOutdoorIds) {
    return cachedOutdoorIds;
  }

  const ids = new Set<number>();
  const dataDir = path.resolve(__dirname, '..', '..', 'public', 'data');
  const xml = withoutXmlComments(fs.readFileSync(path.join(dataDir, 'restaurant.xml'), 'utf8'));
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

// ADR-0042: items whose `type` contains "stackable" (Crate/Sake Keg/Barrel/…)
// can legitimately stack several copies on one tile, so duplicate cleanup and
// save-time reconciliation must never merge them.
export function stackableItemIds(): ReadonlySet<number> {
  if (cachedStackableIds) {
    return cachedStackableIds;
  }

  const ids = new Set<number>();
  const dataDir = path.resolve(__dirname, '..', '..', 'public', 'data');
  for (const file of CATALOG_FILES) {
    let xml = '';
    try { xml = fs.readFileSync(path.join(dataDir, file), 'utf8'); } catch { continue; }
    for (const match of withoutXmlComments(xml).matchAll(ITEM_TAG)) {
      if (/type="[^"]*stackable/.test(match[1] ?? '')) {
        const id = Number(attribute(match[1], 'id'));
        if (Number.isInteger(id)) ids.add(id);
      }
    }
  }

  cachedStackableIds = ids;
  return cachedStackableIds;
}

export function isStackableItemId(globalItemId: number): boolean {
  return stackableItemIds().has(globalItemId);
}

// ADR-0042: walls legitimately hold several decorations (windows/pictures) at
// one position, so wall-decoration items are exempt from duplicate cleanup and
// save-time reconciliation too.
export function wallDecorationItemIds(): ReadonlySet<number> {
  if (cachedWallDecorationIds) {
    return cachedWallDecorationIds;
  }

  const ids = new Set<number>();
  const dataDir = path.resolve(__dirname, '..', '..', 'public', 'data');
  let xml: string;
  try {
    xml = withoutXmlComments(fs.readFileSync(path.join(dataDir, 'restaurant.xml'), 'utf8'));
  } catch {
    cachedWallDecorationIds = ids;
    return ids;
  }
  for (const match of xml.matchAll(GROUP_BLOCK)) {
    if (!/\btype="[^"]*\bwallDecorationItem\b[^"]*"/.test(match[1] ?? '')) {
      continue;
    }
    for (const item of (match[2] ?? '').matchAll(ITEM_TAG)) {
      const id = Number(attribute(item[1], 'id'));
      if (Number.isInteger(id)) {
        ids.add(id);
      }
    }
  }

  cachedWallDecorationIds = ids;
  return cachedWallDecorationIds;
}

export function isWallDecorationItemId(globalItemId: number): boolean {
  return wallDecorationItemIds().has(globalItemId);
}

// GameUser.addOwnedItem keeps these restaurant groups out of
// usedRestaurantItems. Action 51 clears only usedRestaurantItems, so the
// server must preserve these separately managed ownership entitlements.
const NON_EDITABLE_RESTAURANT_GROUPS = new Set([360, 390, 391]);

export function isNonEditableRestaurantEntitlementItem(globalItemId: number): boolean {
  return NON_EDITABLE_RESTAURANT_GROUPS.has(Math.floor(globalItemId / 10_000));
}

export function isFoodKingEligibleItem(id: number): boolean {
  return itemAttributes(id)?.foodKingFeed === 'true';
}

/**
 * Whether a player may gift this item through the sendMail RPC. Mirrors the
 * shipped client's onGiftItem gate (WorldRestaurantEditor.as / ItemChooser):
 * the item must be a real catalog row that is not shop-hidden and not flagged
 * notGiftable. Without this the server minted any positive item id a crafted
 * gift request carried — e.g. invisible/unavailable rows like the 3 Million
 * Fans Statue (3500093) arrived even though they are not obtainable.
 */
export function isGiftableItemId(id: number): boolean {
  const attrs = itemAttributes(id);
  if (!attrs) return false;
  if (attrs.invisible === 'true') return false;
  if (/\bnotGiftable\b/.test(attrs.type ?? '')) return false;
  return true;
}

export function isEmployeeSnackItem(id: number): boolean {
  const entry = catalogEntry(id);
  if (entry?.category !== 'perk') return false;
  try {
    const xml = withoutXmlComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'data', 'perk.xml'), 'utf8'));
    const group = xml.match(/<group\s+name="Employee">([\s\S]*?)<\/group>/)?.[1] ?? '';
    return new RegExp(`<item\\b[^>]*\\bid="${id}"`).test(group);
  } catch {
    return false;
  }
}
