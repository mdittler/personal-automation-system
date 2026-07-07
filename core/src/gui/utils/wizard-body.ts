/**
 * Shared wizard step-POST body normalization (final Codex review round, Important).
 *
 * Fastify's default JSON body parser (used by report-wizard.ts/alert-wizard.ts's
 * `Body: Record<string, string>` typed routes) preserves repeated form keys as
 * a `string[]` rather than coalescing them into a single string — e.g. a
 * multi-select "Send to" checkbox group posts `delivery_user` as an array
 * when more than one recipient is checked. Every wizard step handler types
 * its body as `Record<string, string>` and both `renderStepN` functions spread
 * the raw body into the accumulated `values` map that flows to
 * `hiddenFields()`, which calls `escapeHtml(v)` assuming `v` is always a
 * string. An array value throws inside `escapeHtml` (`str.replace is not a
 * function`), 500ing the whole step.
 *
 * `normalizeBody` fixes this at the step-POST boundary, before any renderer
 * sees the body:
 *   1. Any UI-only multi-value key present in `arrayKeys` (by convention,
 *      just `delivery_user`) is consumed into `computedDelivery` — a single
 *      comma-joined string — and REMOVED from the returned body, so it never
 *      reaches `hiddenFields()` as a stray field.
 *   2. Any OTHER key that arrives as `string[]` (not one of `arrayKeys`) is
 *      normalized to a single string by joining with ", " — the same
 *      deterministic policy as `computedDelivery`, applied uniformly so a
 *      surprise repeated key never crashes the renderer either.
 *
 * Both report-wizard.ts and alert-wizard.ts call this identically.
 */

const ARRAY_JOIN_SEPARATOR = ', ';

export interface NormalizedWizardBody {
	/** The body with every array-valued field coalesced to a single string. */
	body: Record<string, string>;
	/** Comma-joined values collected from `delivery_user`, in submission order, empty strings dropped. */
	delivery: string[];
}

/**
 * Normalize a raw wizard step-POST body.
 *
 * `delivery_user` (the "Send to" checkbox group's field name in both
 * wizards) is treated specially: it's a UI-only key that both wizards
 * consume into a computed `delivery` array/string and never persist as
 * itself, so it's dropped from the returned body entirely (not merely
 * stringified) — this also makes it safe to call BEFORE the exclusion-set
 * logic in `hiddenFields()`, which never lists `delivery_user` as excluded.
 *
 * Every other field that arrives as `string[]` (an unexpected repeated key)
 * is joined with ", " rather than dropped, so wizard values are never
 * silently lost — just flattened to the same string shape every other field
 * already has.
 */
export function normalizeBody(
	rawBody: Record<string, string | string[] | undefined>,
): NormalizedWizardBody {
	const body: Record<string, string> = {};
	let delivery: string[] = [];

	for (const [key, value] of Object.entries(rawBody)) {
		if (value === undefined) continue;

		if (key === 'delivery_user') {
			delivery = ([] as string[]).concat(value).filter(Boolean);
			continue; // UI-only key — never echoed back as a hidden field.
		}

		body[key] = Array.isArray(value) ? value.join(ARRAY_JOIN_SEPARATOR) : value;
	}

	return { body, delivery };
}
