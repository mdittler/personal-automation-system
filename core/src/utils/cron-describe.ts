/**
 * Cron expression utilities for human-readable descriptions and next-run computation.
 */

import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';

/**
 * Convert a 5-field cron expression to a human-readable string.
 * Returns the raw expression on failure.
 */
export function describeCron(expression: string): string {
	try {
		return cronstrue.toString(expression, { use24HourTimeFormat: false, verbose: true });
	} catch {
		return expression;
	}
}

/**
 * Compute the next run time for a cron expression in the given timezone.
 * Returns null for invalid expressions.
 */
export function getNextRun(expression: string, timezone: string): Date | null {
	try {
		const expr = CronExpressionParser.parse(expression, { tz: timezone });
		const next = expr.next();
		return next.toDate();
	} catch {
		return null;
	}
}

/**
 * Format a date as a relative time string (e.g., "in 2h 15m", "3d ago").
 * Uses the current time as reference.
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
	const diffMs = date.getTime() - now.getTime();
	if (Number.isNaN(diffMs)) return 'unknown';
	const absDiff = Math.abs(diffMs);
	const isFuture = diffMs > 0;

	const minutes = Math.floor(absDiff / 60_000);
	const hours = Math.floor(absDiff / 3_600_000);
	const days = Math.floor(absDiff / 86_400_000);

	let relative: string;
	if (minutes < 1) {
		relative = 'now';
	} else if (minutes < 60) {
		relative = `${minutes}m`;
	} else if (hours < 24) {
		const remainingMinutes = minutes % 60;
		relative = remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
	} else {
		const remainingHours = hours % 24;
		relative = remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
	}

	if (relative === 'now') return relative;
	return isFuture ? `in ${relative}` : `${relative} ago`;
}

/**
 * Format a date for display using the given timezone.
 * Returns ISO string fallback on invalid timezone or date.
 */
export function formatDateTime(date: Date, timezone: string): string {
	try {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
		}).format(date);
	} catch {
		// Invalid timezone or NaN date — fall back to ISO string or placeholder
		try {
			return date.toISOString();
		} catch {
			return 'Invalid date';
		}
	}
}
