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
});
