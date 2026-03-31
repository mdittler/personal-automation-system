/**
 * Timezone-aware date formatting helpers.
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
