/**
 * Health store service — per-user monthly health metric storage.
 *
 * Parallel in structure to macro-tracker.ts: per-user monthly YAML files
 * at health/YYYY-MM.yaml store daily health entries from cross-app events.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { generateFrontmatter, stripFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { HealthDailyMetricsPayload } from '../events/types.js';

export interface DailyHealthEntry {
	date: string; // YYYY-MM-DD
	metrics: HealthDailyMetricsPayload['metrics'];
	source: string; // emitting app id
}

export interface MonthlyHealthLog {
	month: string; // YYYY-MM
	userId: string;
	days: DailyHealthEntry[];
}

function healthPath(month: string): string {
	// Validate YYYY-MM format to prevent path traversal (mirrors nutritionPath in macro-tracker.ts)
	if (!/^\d{4}-\d{2}$/.test(month)) {
		throw new Error(`Invalid month format: expected YYYY-MM`);
	}
	return `health/${month}.yaml`;
}

export async function loadMonthlyHealth(
	store: ScopedDataStore,
	month: string,
): Promise<MonthlyHealthLog | null> {
	const raw = await store.read(healthPath(month));
	if (!raw) return null;

	try {
		const content = stripFrontmatter(raw);
		if (!content.trim()) return null;
		const data = parse(content) as MonthlyHealthLog;
		// Require both month and userId — a log without userId is corrupt/incomplete
		if (!data?.month || !data?.userId) return null;
		return {
			month: data.month,
			userId: data.userId,
			days: data.days ?? [],
		};
	} catch {
		return null;
	}
}

export async function saveMonthlyHealth(
	store: ScopedDataStore,
	log: MonthlyHealthLog,
): Promise<void> {
	const fm = generateFrontmatter({
		title: `Health ${log.month}`,
		date: new Date().toISOString(),
		tags: buildAppTags('food', 'health'),
		type: 'health-metrics',
		app: 'food',
	});
	const body = stringify({
		month: log.month,
		userId: log.userId,
		days: log.days,
	});
	await store.write(healthPath(log.month), fm + body);
}

/**
 * Insert or replace a daily health entry for the given user.
 * Upsert semantics: replaces an existing entry with the same date.
 */
export async function upsertDailyHealth(
	store: ScopedDataStore,
	userId: string,
	entry: DailyHealthEntry,
): Promise<void> {
	// Validate YYYY-MM-DD format before slicing to avoid passing a bad month to healthPath
	if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
		throw new Error(`Invalid date format: expected YYYY-MM-DD, got '${entry.date}'`);
	}
	const month = entry.date.slice(0, 7); // YYYY-MM
	let log = await loadMonthlyHealth(store, month);
	if (!log) {
		log = { month, userId, days: [] };
	}

	const idx = log.days.findIndex(d => d.date === entry.date);
	if (idx >= 0) {
		log.days[idx] = entry;
	} else {
		log.days.push(entry);
	}

	await saveMonthlyHealth(store, log);
}

/**
 * Load all daily health entries in [startDate, endDate] (inclusive, YYYY-MM-DD).
 * Spans month boundaries. Returns entries sorted chronologically.
 */
export async function loadHealthForPeriod(
	store: ScopedDataStore,
	startDate: string,
	endDate: string,
): Promise<DailyHealthEntry[]> {
	const start = new Date(startDate);
	const end = new Date(endDate);
	const months = new Set<string>();

	// Advance month-by-month from the month containing startDate through the month
	// containing endDate. The loop includes the end month because cursor starts at
	// the 1st of each month and cursor <= end is true while cursor is in end's month.
	const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
	while (cursor <= end) {
		months.add(cursor.toISOString().slice(0, 7));
		cursor.setUTCMonth(cursor.getUTCMonth() + 1);
	}

	const entries: DailyHealthEntry[] = [];
	for (const month of months) {
		const log = await loadMonthlyHealth(store, month);
		if (!log) continue;
		for (const day of log.days) {
			if (day.date >= startDate && day.date <= endDate) {
				entries.push(day);
			}
		}
	}

	return entries.sort((a, b) => a.date.localeCompare(b.date));
}
