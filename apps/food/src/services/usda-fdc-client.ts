/**
 * USDA FoodData Central API client.
 *
 * Used as a sanity-check alongside the LLM macro estimate when the
 * user creates a quick-meal template. Never sends data to an LLM.
 * API key is read from the caller — callers should source it from
 * system config or env, never from user input.
 *
 * Graceful degradation: any failure returns `null` so the calling
 * code can proceed with an LLM-only estimate.
 */

export interface UsdaCrossCheck {
  calories: number;
  matchedIngredients: number;
  totalIngredients: number;
}

const ENDPOINT = 'https://api.nal.usda.gov/fdc/v1/foods/search';

async function searchIngredient(
  query: string,
  apiKey: string,
): Promise<number | null> {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&pageSize=1&api_key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      foods?: Array<{
        foodNutrients?: Array<{ nutrientName?: string; value?: number; unitName?: string }>;
      }>;
    };
    const first = data.foods?.[0];
    if (!first) return 0; // no match, but API itself responded
    const energy = first.foodNutrients?.find(
      n => n.nutrientName === 'Energy' && n.unitName === 'KCAL',
    );
    return energy?.value ?? 0;
  } catch {
    return null;
  }
}

/**
 * Cross-checks a list of ingredients against USDA FDC.
 * Returns the sum of per-ingredient calorie matches, or `null` on
 * any hard failure (HTTP error, no API key, network error).
 */
export async function crossCheckIngredients(
  ingredients: string[],
  apiKey: string,
): Promise<UsdaCrossCheck | null> {
  if (!apiKey) return null;
  let total = 0;
  let matched = 0;
  let hadFailure = false;
  for (const ing of ingredients) {
    const cal = await searchIngredient(ing, apiKey);
    if (cal === null) { hadFailure = true; break; }
    if (cal > 0) { matched++; total += cal; }
  }
  if (hadFailure) return null;
  return { calories: Math.round(total), matchedIngredients: matched, totalIngredients: ingredients.length };
}
