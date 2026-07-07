/**
 * Turn a human-entered name into a REPORT_ID_PATTERN / ALERT_ID_PATTERN
 * (`^[a-z][a-z0-9-]*$`) id, with a collision-suffix helper. Used by the
 * report/alert wizards' step-3/step-4 handlers so a blank "ID" field
 * auto-derives from the name instead of relying on a hand-typed value
 * silently blocked by HTML5 pattern validation (B1 live-verification fix).
 */

/** Generic fallback id when a name has no sluggable [a-z0-9] characters at all. */
const FALLBACK_ID = 'item';

/**
 * Slugify `name` into a lowercase, hyphenated id matching
 * `^[a-z][a-z0-9-]*$`. If the slug would start with a digit (e.g. "2026
 * Summary"), prefix it with `r-` so it stays pattern-valid rather than
 * silently producing an id the service will reject. Falls back to
 * `FALLBACK_ID` when nothing sluggable remains.
 */
export function slugifyForId(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');

	if (!base) return FALLBACK_ID;
	if (!/^[a-z]/.test(base)) return `r-${base}`;
	return base;
}

/**
 * Resolve `baseSlug` to a unique id by probing `lookup` (typically
 * `reportService.getReport` / `alertService.getAlert`) and appending
 * `-2`, `-3`, ... until an id that doesn't already exist is found.
 */
export async function uniqueSlugForId(
	baseSlug: string,
	lookup: (id: string) => Promise<unknown>,
): Promise<string> {
	let id = baseSlug;
	let suffix = 2;
	while (await lookup(id)) {
		id = `${baseSlug}-${suffix}`;
		suffix++;
	}
	return id;
}
