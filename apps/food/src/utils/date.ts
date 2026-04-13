/**
 * Timezone-aware date formatting helpers and UTC-safe date arithmetic.
 */

/** Get today's date as YYYY-MM-DD in the configured timezone. */
export function todayDate(timezone: string): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
	}).format(new Date());
}

/** Get current time as HH:MM in the configured timezone. */
export function currentTime(timezone: string): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).format(new Date());
}

/** Get an ISO timestamp string. */
export function isoNow(): string {
	return new Date().toISOString();
}

/** Generate a short random ID for recipes, plans, etc. */
export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Add (or subtract) a number of days to a YYYY-MM-DD date string.
 * Uses UTC arithmetic to avoid DST-driven date shifts.
 */
export function addDays(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * Compute the ISO 8601 week ID (e.g. "2026-W15") for a given YYYY-MM-DD date.
 * Uses the Thursday rule: a week belongs to the year containing its Thursday.
 */
export function getIsoWeekId(dateStr: string): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	// Day of week: 0 = Sunday … 6 = Saturday. Shift to Mon=0 … Sun=6.
	const dayOfWeek = (d.getUTCDay() + 6) % 7;
	// Find Thursday of this week
	const thursday = new Date(d);
	thursday.setUTCDate(d.getUTCDate() - dayOfWeek + 3);
	// Jan 4 is always in week 1
	const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
	const jan4DayOfWeek = (jan4.getUTCDay() + 6) % 7;
	const week1Monday = new Date(jan4);
	week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayOfWeek);
	const weekNumber = Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * 24 * 3600 * 1000)) + 1;
	const year = thursday.getUTCFullYear();
	return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}
