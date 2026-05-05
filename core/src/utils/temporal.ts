/**
 * Temporal utility helpers for PAS.
 *
 * Single source of truth for calendar-strict date validation and timezone-aware
 * UTC range computation (Chunk G).
 */

/**
 * Map a local calendar day to its UTC half-open interval [startUtc, endUtcExclusive).
 *
 * Uses Intl.DateTimeFormat with a binary-search algorithm to compute DST-correct
 * UTC boundaries for any IANA timezone. The caller MUST pre-validate `localDate`
 * with isCalendarStrict().
 *
 * DST edge cases:
 *  - Spring forward (e.g. America/New_York 2026-03-08): local midnight exists in
 *    EST (UTC-5). startUtc = 05:00Z, endUtcExclusive = 04:00Z next day (23-hour day).
 *  - Fall back (e.g. America/New_York 2026-11-01): local midnight exists in EDT
 *    (UTC-4). startUtc = 04:00Z, endUtcExclusive = 05:00Z next day (25-hour day).
 */
export function localDayToUtcRange(
	localDate: string,
	tz: string,
): { startUtc: string; endUtcExclusive: string } {
	const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];

	const startMs = findLocalMidnightUtcMs(y, m, d, tz);

	// Compute the calendar date of the next day in UTC (DST-safe: add 25h to land
	// firmly in the next day, then read back the UTC date components).
	const utcSeedNextDay = Date.UTC(y, m - 1, d + 1, 12, 0, 0);
	const nd = new Date(utcSeedNextDay);
	const endMs = findLocalMidnightUtcMs(
		nd.getUTCFullYear(),
		nd.getUTCMonth() + 1,
		nd.getUTCDate(),
		tz,
	);

	return {
		startUtc: new Date(startMs).toISOString(),
		endUtcExclusive: new Date(endMs).toISOString(),
	};
}

/**
 * Binary-search the UTC millisecond that corresponds to local midnight on the
 * given calendar date in the given timezone.
 *
 * Invariant: the UTC time for local midnight is in the range
 *   [Date.UTC(year, month-1, day) − 14h, Date.UTC(year, month-1, day) + 14h]
 * (because UTC offsets span −12 to +14).
 *
 * The search finds the first UTC ms where the formatted local date is `targetDate`
 * AND the formatted local time is 00:00:00 — i.e. the lower bound of that day.
 */
function findLocalMidnightUtcMs(year: number, month: number, day: number, tz: string): number {
	const targetDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});

	function getLocalParts(utcMs: number): {
		date: string;
		hour: number;
		minute: number;
		second: number;
	} {
		const parts = fmt.formatToParts(new Date(utcMs));
		const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
		const year_ = get('year');
		const month_ = get('month');
		const day_ = get('day');
		return {
			date: `${year_}-${month_}-${day_}`,
			hour: Number(get('hour')),
			minute: Number(get('minute')),
			second: Number(get('second')),
		};
	}

	/**
	 * Returns < 0 if utcMs is before local midnight on targetDate,
	 *         >= 0 if utcMs is at or after local midnight on targetDate.
	 */
	function compareToMidnight(utcMs: number): number {
		const p = getLocalParts(utcMs);
		if (p.date < targetDate) return -1;
		if (p.date > targetDate) return 1;
		// Same date: midnight is 00:00:00
		return p.hour * 3_600 + p.minute * 60 + p.second;
	}

	// Search bounds: ±14h around UTC midnight of the same calendar date
	const utcDayMs = Date.UTC(year, month - 1, day);
	let lo = utcDayMs - 14 * 3_600_000; // guaranteed before local midnight
	let hi = utcDayMs + 14 * 3_600_000; // guaranteed after local midnight

	// Narrow to 1-second precision
	while (hi - lo > 1_000) {
		const mid = Math.floor((lo + hi) / 2);
		if (compareToMidnight(mid) < 0) {
			lo = mid;
		} else {
			hi = mid;
		}
	}

	// Round down to the nearest second.
	// hi is guaranteed to be within 1000ms of the true midnight (which always falls on a
	// whole-second boundary). Sub-second values arise because Intl.DateTimeFormat truncates
	// to whole seconds when formatting, so the binary search overshoots by < 1 second.
	// Flooring gives the correct whole-second UTC instant for local midnight.
	return Math.floor(hi / 1_000) * 1_000;
}

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
