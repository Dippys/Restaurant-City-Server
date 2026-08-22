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
