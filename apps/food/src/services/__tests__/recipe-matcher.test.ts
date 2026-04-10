import { describe, it, expect } from 'vitest';
import { matchRecipes } from '../recipe-matcher.js';
import type { Recipe } from '../../types.js';

const R = (id: string, title: string): Recipe =>
  ({ id, title, ingredients: [], steps: [], tags: [] } as unknown as Recipe);

describe('matchRecipes', () => {
  const recipes: Recipe[] = [
    R('r1', 'Classic Lasagna'),
    R('r2', 'Chicken Curry'),
    R('r3', 'Thai Red Chicken Curry'),
    R('r4', 'Vegan Chili'),
  ];

  it('returns unique exact match', () => {
    const res = matchRecipes('lasagna', recipes);
    expect(res.kind).toBe('unique');
    if (res.kind === 'unique') expect(res.recipe.id).toBe('r1');
  });

  it('returns ambiguous for multi-match', () => {
    const res = matchRecipes('chicken curry', recipes);
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous') {
      expect(res.candidates.length).toBe(2);
    }
  });

  it('returns none for no match', () => {
    const res = matchRecipes('sushi platter', recipes);
    expect(res.kind).toBe('none');
  });

  it('is case-insensitive and tolerates extra words', () => {
    const res = matchRecipes('CLASSIC LASAGNA dinner', recipes);
    expect(res.kind).toBe('unique');
    if (res.kind === 'unique') expect(res.recipe.id).toBe('r1');
  });

  it('ignores short noise words', () => {
    const res = matchRecipes('the chili', recipes);
    expect(res.kind).toBe('unique');
    if (res.kind === 'unique') expect(res.recipe.id).toBe('r4');
  });

  // M1: unicode-aware tokenization — diacritics must be folded so that a user
  // typing "pate" still matches a recipe titled "Pâté de campagne".
  it('folds unicode diacritics when matching titles (M1)', () => {
    const recipes: Recipe[] = [R('r5', 'Pâté de campagne')];
    const res = matchRecipes('pate', recipes);
    expect(res.kind).toBe('unique');
    if (res.kind === 'unique') expect(res.recipe.id).toBe('r5');
  });

  // M4: ambiguous candidate list is capped at 5 to avoid oversized Telegram
  // button grids.
  it('caps ambiguous candidate list at 5 (M4)', () => {
    const many: Recipe[] = Array.from({ length: 10 }, (_, i) =>
      R(`r${i}`, `Chicken Special ${i}`),
    );
    const res = matchRecipes('chicken special', many);
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous') {
      expect(res.candidates.length).toBeLessThanOrEqual(5);
    }
  });
});
