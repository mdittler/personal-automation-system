import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crossCheckIngredients } from '../usda-fdc-client.js';

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

const fdcHit = (calories: number) => ({
  foods: [{
    description: 'mock',
    foodNutrients: [{ nutrientName: 'Energy', value: calories, unitName: 'KCAL' }],
  }],
});

describe('crossCheckIngredients', () => {
  it('sums calories across ingredients', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => fdcHit(200) })
      .mockResolvedValueOnce({ ok: true, json: async () => fdcHit(100) });

    const res = await crossCheckIngredients(
      ['chicken breast', 'brown rice'],
      'fake-key',
    );
    expect(res!.calories).toBe(300);
    expect(res!.matchedIngredients).toBe(2);
    expect(res!.totalIngredients).toBe(2);
  });

  it('handles no-match gracefully', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ foods: [] }) });
    const res = await crossCheckIngredients(['mystery food'], 'fake-key');
    expect(res!.calories).toBe(0);
    expect(res!.matchedIngredients).toBe(0);
    expect(res!.totalIngredients).toBe(1);
  });

  it('returns null on HTTP failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const res = await crossCheckIngredients(['chicken'], 'fake-key');
    expect(res).toBeNull();
  });

  it('returns null when api key empty', async () => {
    const res = await crossCheckIngredients(['chicken'], '');
    expect(res).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
