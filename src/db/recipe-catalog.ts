import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface RecipeEntry {
  readonly id: number;
  readonly hash: string;
  readonly ingredientIds: readonly number[];
}

let cachedRecipes: Map<string, RecipeEntry> | null = null;

export function resolveRecipeEntry(token: string): RecipeEntry | undefined {
  const recipes = recipeMap();
  return recipes.get(token) ?? recipes.get(String(numericToken(token)));
}

function recipeMap(): Map<string, RecipeEntry> {
  if (cachedRecipes) {
    return cachedRecipes;
  }

  const ingredientIdsByName = readIngredientIdsByName();
  const recipes = new Map<string, RecipeEntry>();
  const recipeXml = readDataFile('decompiled/bins/recipe/recipe.xml');

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
  const ingredientXml = readDataFile('decompiled/bins/ingredient/ingredient.xml');

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
  for (const base of candidateRoots()) {
    const path = join(base, relativePath);
    if (existsSync(path)) {
      return readFileSync(path, 'utf8');
    }
  }

  throw new Error(`Cannot find client data file: ${relativePath}`);
}

function candidateRoots(): string[] {
  return [
    resolve(process.cwd(), '..'),
    resolve(process.cwd()),
    resolve(__dirname, '..', '..', '..'),
  ];
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
