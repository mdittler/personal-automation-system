import type { Recipe } from '../types.js';

export type RecipeMatchResult =
  | { kind: 'unique'; recipe: Recipe }
  | { kind: 'ambiguous'; candidates: Recipe[] }
  | { kind: 'none' };

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'some', 'my', 'our', 'dinner', 'lunch',
  'breakfast', 'snack', 'meal',
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Fuzzy match user free text to a recipe in `recipes`.
 * Scores each recipe by token-overlap count. Returns:
 *   - unique: exactly one top scorer with score ≥ 1
 *   - ambiguous: multiple tied at top score
 *   - none: no recipe shares any token
 */
export function matchRecipes(input: string, recipes: Recipe[]): RecipeMatchResult {
  const inputTokens = tokens(input);
  if (inputTokens.length === 0) return { kind: 'none' };

  let best = 0;
  const scored: Array<{ recipe: Recipe; score: number }> = [];
  for (const recipe of recipes) {
    const titleTokens = new Set(tokens(recipe.title));
    let score = 0;
    for (const t of inputTokens) if (titleTokens.has(t)) score++;
    if (score > 0) {
      scored.push({ recipe, score });
      if (score > best) best = score;
    }
  }

  if (best === 0) return { kind: 'none' };

  const top = scored.filter(s => s.score === best);
  if (top.length === 1) return { kind: 'unique', recipe: top[0]!.recipe };
  return { kind: 'ambiguous', candidates: top.map(s => s.recipe) };
}
