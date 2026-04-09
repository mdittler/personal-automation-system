import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScopedDataStore } from '@pas/core/types';
import {
  loadQuickMeals,
  saveQuickMeal,
  archiveQuickMeal,
  slugifyLabel,
  findQuickMealById,
  incrementUsage,
} from '../quick-meals-store.js';
import type { QuickMealTemplate } from '../../types.js';

function createMockStore() {
  const storage = new Map<string, string>();
  return {
    read: vi.fn(async (path: string) => storage.get(path) ?? null),
    write: vi.fn(async (path: string, content: string) => {
      storage.set(path, content);
    }),
    append: vi.fn(async () => {}),
    exists: vi.fn(async (path: string) => storage.has(path)),
    list: vi.fn(async () => []),
    archive: vi.fn(async () => {}),
  };
}

const template = (overrides: Partial<QuickMealTemplate> = {}): QuickMealTemplate => ({
  id: 'chipotle-chicken-bowl',
  userId: 'u1',
  label: 'Chipotle chicken bowl',
  kind: 'restaurant',
  ingredients: ['brown rice', 'chicken', 'guac', 'salsa'],
  estimatedMacros: { calories: 850, protein: 50, carbs: 80, fat: 35, fiber: 12 },
  confidence: 0.75,
  llmModel: 'claude-haiku-4-5',
  usageCount: 0,
  createdAt: '2026-04-09T12:00:00Z',
  updatedAt: '2026-04-09T12:00:00Z',
  ...overrides,
});

describe('slugifyLabel', () => {
  it('lowercases, hyphenates, strips unsafe chars', () => {
    expect(slugifyLabel('Chipotle Chicken Bowl!!!')).toBe('chipotle-chicken-bowl');
    expect(slugifyLabel('  breakfast #1  ')).toBe('breakfast-1');
    expect(slugifyLabel('../../etc/passwd')).toBe('etc-passwd');
  });
  it('rejects empty result', () => {
    expect(() => slugifyLabel('!!!')).toThrow();
  });
});

describe('quick-meals-store', () => {
  let store: ReturnType<typeof createMockStore>;
  beforeEach(() => { store = createMockStore(); });

  it('round-trips a single template', async () => {
    await saveQuickMeal(store as unknown as ScopedDataStore, template());
    const list = await loadQuickMeals(store as unknown as ScopedDataStore);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('Chipotle chicken bowl');
    expect(list[0].estimatedMacros.calories).toBe(850);
  });

  it('updates existing template by id (upsert)', async () => {
    await saveQuickMeal(store as unknown as ScopedDataStore, template());
    await saveQuickMeal(store as unknown as ScopedDataStore, template({ usageCount: 3 }));
    const list = await loadQuickMeals(store as unknown as ScopedDataStore);
    expect(list).toHaveLength(1);
    expect(list[0].usageCount).toBe(3);
  });

  it('archives a template (removes from active list)', async () => {
    await saveQuickMeal(store as unknown as ScopedDataStore, template());
    await archiveQuickMeal(store as unknown as ScopedDataStore, 'chipotle-chicken-bowl');
    const list = await loadQuickMeals(store as unknown as ScopedDataStore);
    expect(list).toHaveLength(0);
  });

  it('stores multiple distinct templates', async () => {
    await saveQuickMeal(store as unknown as ScopedDataStore, template({ id: 'foo', label: 'Foo' }));
    await saveQuickMeal(store as unknown as ScopedDataStore, template({ id: 'bar', label: 'Bar' }));
    const list = await loadQuickMeals(store as unknown as ScopedDataStore);
    expect(list).toHaveLength(2);
  });

  it('findQuickMealById returns the template', async () => {
    await saveQuickMeal(store as unknown as ScopedDataStore, template());
    const found = await findQuickMealById(store as unknown as ScopedDataStore, 'chipotle-chicken-bowl');
    expect(found?.label).toBe('Chipotle chicken bowl');
    const missing = await findQuickMealById(store as unknown as ScopedDataStore, 'nonexistent');
    expect(missing).toBeUndefined();
  });

  it('incrementUsage bumps usageCount and lastUsedAt', async () => {
    await saveQuickMeal(store as unknown as ScopedDataStore, template());
    await incrementUsage(store as unknown as ScopedDataStore, 'chipotle-chicken-bowl');
    const list = await loadQuickMeals(store as unknown as ScopedDataStore);
    expect(list[0].usageCount).toBe(1);
    expect(list[0].lastUsedAt).toBeDefined();
  });

  it('rejects unsafe slug id on save', async () => {
    await expect(
      saveQuickMeal(store as unknown as ScopedDataStore, template({ id: '../etc/passwd' })),
    ).rejects.toThrow();
  });
});
