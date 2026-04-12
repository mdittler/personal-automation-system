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

  // ── Hardening regression tests (H11.w thorough review) ──

  // M2: Zod validation at the persistence boundary rejects invalid templates
  // even if a future code path bypasses the guided flow.
  it('rejects label with markdown special characters (M2/H6)', async () => {
    await expect(
      saveQuickMeal(store as unknown as ScopedDataStore, template({ label: 'my *pizza*' })),
    ).rejects.toThrow(/markdown special/);
  });

  it('rejects oversized label at the persistence boundary (M2)', async () => {
    await expect(
      saveQuickMeal(store as unknown as ScopedDataStore, template({ label: 'a'.repeat(101) })),
    ).rejects.toThrow(/label too long/);
  });

  it('rejects > 50 ingredients at the persistence boundary (M2)', async () => {
    await expect(
      saveQuickMeal(
        store as unknown as ScopedDataStore,
        template({ ingredients: Array.from({ length: 51 }, () => 'x') }),
      ),
    ).rejects.toThrow();
  });

  // M3: archive FIFO cap — unbounded growth would balloon the YAML file.
  it('caps archive at ARCHIVE_MAX via FIFO eviction (M3)', async () => {
    // Pre-seed the file directly with 500 archived items + one active.
    // Going through saveQuickMeal 500x is too slow for a unit test.
    const { stringify } = await import('yaml');
    const seed = {
      active: [template({ id: 'about-to-archive', label: 'About to archive' })],
      archive: Array.from({ length: 500 }, (_, i) =>
        template({ id: `archived-${i}`, label: `Archived ${i}` }),
      ),
    };
    (store as any).read = vi.fn(async () => `---\ntags: [food]\n---\n${stringify(seed)}`);
    const writes: Array<[string, string]> = [];
    (store as any).write = vi.fn(async (path: string, content: string) => {
      writes.push([path, content]);
    });

    await archiveQuickMeal(store as unknown as ScopedDataStore, 'about-to-archive');

    const raw = writes.at(-1)?.[1] ?? '';
    // The oldest archived item should have been FIFO-evicted.
    expect(raw).not.toContain('id: archived-0\n');
    // The newly archived item should now be in archive.
    expect(raw).toContain('id: about-to-archive');
    // The most recent kept items should still be there.
    expect(raw).toContain('id: archived-499');
  });

  // H3: a corrupt YAML file must be preserved, not silently overwritten.
  it('preserves corrupt YAML to a sidecar file instead of overwriting (H3)', async () => {
    // Seed the store with a frontmatter + broken YAML body.
    const corrupt = '---\ntags: [food]\n---\nactive:\n  - id: foo\n  ingredients: [unterminated';
    (store as any).read = vi.fn(async (path: string) => {
      if (path === 'quick-meals.yaml') return corrupt;
      return null;
    });
    const writes: Array<[string, string]> = [];
    (store as any).write = vi.fn(async (path: string, content: string) => {
      writes.push([path, content]);
    });

    // Silence the expected "corrupt YAML preserved" console.error
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await saveQuickMeal(store as unknown as ScopedDataStore, template());
    } finally {
      errSpy.mockRestore();
    }

    // A sidecar .corrupt-<ts> file should have been written with the original.
    const sidecar = writes.find(([p]) => p.startsWith('corrupt/quick-meals-'));
    expect(sidecar).toBeDefined();
    expect(sidecar?.[1]).toBe(corrupt);
  });

  // H4: concurrent saves must not lose each other's mutations.
  it('serializes concurrent saves so no template is lost (H4)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        saveQuickMeal(
          store as unknown as ScopedDataStore,
          template({ id: `parallel-${i}`, label: `Parallel ${i}` }),
        ),
      ),
    );
    const list = await loadQuickMeals(store as unknown as ScopedDataStore);
    expect(list).toHaveLength(10);
    const ids = list.map((t) => t.id).sort();
    expect(ids).toEqual(
      Array.from({ length: 10 }, (_, i) => `parallel-${i}`).sort(),
    );
  });
});
