// ADR-0041: recipes/ingredients read through game-data-store so admin edits to
// recipe.xml / ingredient.xml flow into cooking resolution immediately.
import { gameDataRevision, readDataXml } from './game-data-store';

export interface RecipeEntry {
  readonly id: number;
  readonly hash: string;
  readonly ingredientIds: readonly number[];
}

let cachedRecipes: Map<string, RecipeEntry> | null = null;
let cachedRevision = -1;

export function resolveRecipeEntry(token: string): RecipeEntry | undefined {
  const recipes = recipeMap();
  return recipes.get(token) ?? recipes.get(String(numericToken(token)));
}

function recipeMap(): Map<string, RecipeEntry> {
  const revision = gameDataRevision();
  if (cachedRecipes && cachedRevision === revision) {
    return cachedRecipes;
  }
  cachedRevision = revision;

  const ingredientIdsByName = readIngredientIdsByName();
  const recipes = new Map<string, RecipeEntry>();
  const recipeXml = readDataXml('recipe');

  for (const attrs of readItemAttributes(recipeXml)) {
    const id = Number.parseInt(attrs.id ?? '', 10);
    const hash = attrs.hash ?? '';
    if (!Number.isInteger(id) || !hash) {
      continue;
    }

    const ingredientIds = (attrs.ingredients ?? '')
      .split(/\s*,\s*/)
      .map((name) => ingredientIdsByName.get(name.trim().toLowerCase()))
      .filter((ingredientId): ingredientId is number => Number.isInteger(ingredientId));
    const entry = { id, hash, ingredientIds };
    recipes.set(hash, entry);
    recipes.set(String(id), entry);
  }

  cachedRecipes = recipes;
  return recipes;
}

function readIngredientIdsByName(): Map<string, number> {
  const ingredients = new Map<string, number>();
  const ingredientXml = readDataXml('ingredient');

  for (const attrs of readItemAttributes(ingredientXml)) {
    const id = Number.parseInt(attrs.id ?? '', 10);
    const name = attrs.name?.trim();
    if (Number.isInteger(id) && name) {
      ingredients.set(name.toLowerCase(), id);
    }
  }

  return ingredients;
}

function readDataFile(relativePath: string): string {
  return readDataXml(relativePath.replace(/^public\/data\//, '').replace(/\.xml$/, ''));
}

function readItemAttributes(xml: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  const itemPattern = /<item\s+([^>]+?)\/>/g;
  let match: RegExpExecArray | null;

  while ((match = itemPattern.exec(xml)) !== null) {
    items.push(readAttributes(match[1] ?? ''));
  }

  return items;
}

function readAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attrPattern.exec(value)) !== null) {
    attrs[match[1] ?? ''] = decodeXmlAttribute(match[2] ?? '');
  }

  return attrs;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function numericToken(token: string): number {
  const match = String(token).match(/\d+/);
  return match ? Number.parseInt(match[0] ?? '0', 10) : 0;
}
