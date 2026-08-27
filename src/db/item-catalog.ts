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
  }
  return cachedAttributes.get(id);
}

export function isFoodKingEligibleItem(id: number): boolean {
  return itemAttributes(id)?.foodKingFeed === 'true';
}

export function isEmployeeSnackItem(id: number): boolean {
  const entry = catalogEntry(id);
  if (entry?.category !== 'perk') return false;
  try {
    const xml = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'data', 'perk.xml'), 'utf8');
    const group = xml.match(/<group\s+name="Employee">([\s\S]*?)<\/group>/)?.[1] ?? '';
    return new RegExp(`<item\\b[^>]*\\bid="${id}"`).test(group);
  } catch {
    return false;
  }
}
