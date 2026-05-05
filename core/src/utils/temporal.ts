/**
 * Temporal utility helpers for PAS.
 *
 * Single source of truth for calendar-strict date validation.
 * Additional helpers (timeAnchorToDateRange, etc.) are added in Chunk G.
 */

/**
 * Validate that a string is a calendar-strict ISO date (YYYY-MM-DD).
 *
 * Returns false for:
 *  - Non-ISO strings ("yesterday", "2026-1-5")
 *  - Dates that do not exist in the calendar (2026-02-30, 2026-04-31, 2025-02-29)
 *  - Out-of-range month/day values (2026-13-40)
 *
 * Returns true for valid calendar dates including leap-year days (2024-02-29).
 */
export function isCalendarStrict(s: string): boolean {
	// Must be exactly YYYY-MM-DD with zero-padding
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;

	const year = Number.parseInt(s.slice(0, 4), 10);
	const month = Number.parseInt(s.slice(5, 7), 10);
	const day = Number.parseInt(s.slice(8, 10), 10);

	// Month must be 1–12
	if (month < 1 || month > 12) return false;

	// Use Date.UTC to validate the date, then re-format and compare
	const utc = Date.UTC(year, month - 1, day);
	const d = new Date(utc);

	const reconstructed = [
		String(d.getUTCFullYear()).padStart(4, '0'),
		String(d.getUTCMonth() + 1).padStart(2, '0'),
		String(d.getUTCDate()).padStart(2, '0'),
	].join('-');

	return reconstructed === s;
}
