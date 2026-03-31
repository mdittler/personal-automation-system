/**
 * Date formatting utilities.
 *
 * Consistent date/time formatting for archives, timestamps, and filenames.
 */

/**
 * Format a date as ISO 8601 string (UTC).
 * Used for timestamps in change logs and rule tracking.
 */
export function toISO(date: Date = new Date()): string {
	return date.toISOString();
}

/**
 * Format a date as YYYY-MM-DD for archive filenames and daily grouping.
 */
export function toDateString(date: Date = new Date()): string {
	return date.toISOString().slice(0, 10);
}

/**
 * Format a date as YYYY-MM-DD_HH-mm-ss for unique archive filenames.
 */
export function toArchiveTimestamp(date: Date = new Date()): string {
	return date.toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
}
