/**
 * Change log collector for daily diff.
 *
 * Reads the JSONL change log, filters entries by time window,
 * and groups them by app and user for reporting.
 */

import { readFile } from 'node:fs/promises';
import type { ChangeLogEntry } from '../../types/data-store.js';

/** Grouped changes for a daily diff report. */
export interface DailyChanges {
	date: string;
	entries: ChangeLogEntry[];
	byApp: Record<string, Record<string, ChangeLogEntry[]>>;
}

/**
 * Collect changes from the JSONL log file since the given date.
 * Returns grouped changes ready for reporting.
 */
export async function collectChanges(logPath: string, since: Date): Promise<DailyChanges> {
	const sinceISO = since.toISOString();
	const dateStr = since.toISOString().slice(0, 10);

	let content: string;
	try {
		content = await readFile(logPath, 'utf-8');
	} catch {
		// No log file yet — nothing to report
		return { date: dateStr, entries: [], byApp: {} };
	}

	const lines = content.trim().split('\n');
	const entries: ChangeLogEntry[] = [];
	const byApp: Record<string, Record<string, ChangeLogEntry[]>> = {};

	for (const line of lines) {
		if (!line.trim()) continue;

		let entry: ChangeLogEntry;
		try {
			entry = JSON.parse(line) as ChangeLogEntry;
		} catch {
			// Skip malformed lines
			continue;
		}

		if (entry.timestamp < sinceISO) continue;

		entries.push(entry);

		// Group by app → user
		if (!byApp[entry.appId]) {
			byApp[entry.appId] = {};
		}
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by check above
		const appGroup = byApp[entry.appId]!;
		if (!appGroup[entry.userId]) {
			appGroup[entry.userId] = [];
		}
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by check above
		appGroup[entry.userId]!.push(entry);
	}

	return { date: dateStr, entries, byApp };
}
