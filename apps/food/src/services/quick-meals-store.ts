import type { ScopedDataStore } from '@pas/core/types';
import { parse, stringify } from 'yaml';
import { generateFrontmatter, stripFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import type { QuickMealTemplate } from '../types.js';

const QUICK_MEALS_FILE = 'quick-meals.yaml';
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Slugifies a human label into a safe filesystem-and-key-safe id.
 * Lowercases, replaces non-alphanumeric runs with single hyphens,
 * strips leading/trailing hyphens. Throws on inputs that reduce to nothing.
 */
export function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || !SAFE_SEGMENT.test(slug)) {
    throw new Error(`Invalid label '${label}': produces no safe slug`);
  }
  return slug;
}

interface StoreFile {
  active: QuickMealTemplate[];
  archive: QuickMealTemplate[];
}

async function readFile(store: ScopedDataStore): Promise<StoreFile> {
  const raw = await store.read(QUICK_MEALS_FILE);
  if (!raw) return { active: [], archive: [] };
  try {
    const body = stripFrontmatter(raw);
    if (!body.trim()) return { active: [], archive: [] };
    const parsed = parse(body) as StoreFile | null;
    return {
      active: parsed?.active ?? [],
      archive: parsed?.archive ?? [],
    };
  } catch {
    return { active: [], archive: [] };
  }
}

async function writeFile(store: ScopedDataStore, data: StoreFile): Promise<void> {
  const body = stringify(data);
  const frontmatter = generateFrontmatter({
    tags: buildAppTags('food', 'quick-meals'),
    updated: new Date().toISOString(),
  });
  await store.write(QUICK_MEALS_FILE, `${frontmatter}\n${body}`);
}

/** Returns all active (non-archived) quick-meals. */
export async function loadQuickMeals(store: ScopedDataStore): Promise<QuickMealTemplate[]> {
  const f = await readFile(store);
  return f.active;
}

/** Finds an active quick-meal by id, or returns undefined. */
export async function findQuickMealById(
  store: ScopedDataStore,
  id: string,
): Promise<QuickMealTemplate | undefined> {
  const list = await loadQuickMeals(store);
  return list.find(t => t.id === id);
}

/**
 * Upsert: if a template with the same id exists, replace it; else append.
 * Validates id against SAFE_SEGMENT to prevent path-traversal attempts
 * reaching the file key.
 */
export async function saveQuickMeal(
  store: ScopedDataStore,
  template: QuickMealTemplate,
): Promise<void> {
  if (!SAFE_SEGMENT.test(template.id)) {
    throw new Error(`Unsafe quick-meal id: '${template.id}'`);
  }
  const f = await readFile(store);
  const idx = f.active.findIndex(t => t.id === template.id);
  if (idx >= 0) f.active[idx] = template;
  else f.active.push(template);
  await writeFile(store, f);
}

/** Move a template from active → archive. No-op if not found. */
export async function archiveQuickMeal(
  store: ScopedDataStore,
  id: string,
): Promise<void> {
  const f = await readFile(store);
  const idx = f.active.findIndex(t => t.id === id);
  if (idx < 0) return;
  const [removed] = f.active.splice(idx, 1);
  f.archive.push({ ...removed!, updatedAt: new Date().toISOString() });
  await writeFile(store, f);
}

/** Bump usageCount + lastUsedAt on an active quick-meal. No-op if not found. */
export async function incrementUsage(
  store: ScopedDataStore,
  id: string,
): Promise<void> {
  const f = await readFile(store);
  const t = f.active.find(x => x.id === id);
  if (!t) return;
  t.usageCount += 1;
  t.lastUsedAt = new Date().toISOString();
  await writeFile(store, f);
}
