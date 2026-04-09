/**
 * Parses portion expressions into a numeric multiplier.
 * Accepts: decimals (0.5, 1.5), fractions (1/2, 2/3), unicode
 * vulgar fractions (½, ¼, ¾), and keywords (half, all, whole,
 * quarter, "a small bite", "a bite").
 *
 * Clamps accepted range to (0, 20] to catch typos and prevent
 * absurd values — nobody eats 100 servings of anything.
 */

export type PortionResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3,
  '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

const KEYWORDS: Record<string, number> = {
  half: 0.5,
  all: 1,
  whole: 1,
  quarter: 0.25,
  'a quarter': 0.25,
  'a half': 0.5,
  'a bite': 0.1,
  'a small bite': 0.1,
  bite: 0.1,
};

export function parsePortion(raw: string): PortionResult {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return { ok: false, error: 'empty portion' };

  if (KEYWORDS[trimmed] !== undefined) {
    return { ok: true, value: KEYWORDS[trimmed] };
  }

  if (UNICODE_FRACTIONS[trimmed] !== undefined) {
    return { ok: true, value: UNICODE_FRACTIONS[trimmed] };
  }

  const fractionMatch = trimmed.match(/^(\d+)\/(\d+)$/);
  if (fractionMatch) {
    const num = Number(fractionMatch[1]);
    const den = Number(fractionMatch[2]);
    if (den === 0) return { ok: false, error: 'zero denominator' };
    const v = num / den;
    return clamp(v);
  }

  const num = Number(trimmed);
  if (Number.isFinite(num)) return clamp(num);

  return { ok: false, error: `cannot parse portion: '${raw}'` };
}

function clamp(v: number): PortionResult {
  if (!Number.isFinite(v)) return { ok: false, error: 'not a finite number' };
  if (v <= 0) return { ok: false, error: 'portion must be > 0' };
  if (v > 20) return { ok: false, error: 'portion must be ≤ 20' };
  return { ok: true, value: v };
}
