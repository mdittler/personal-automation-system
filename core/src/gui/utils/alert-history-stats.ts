/**
 * Shared helper counting alert-history files by day.
 *
 * There is no exportable "loader" for alert history — the existing
 * `/gui/alerts/:id/history` route reads `data/system/alert-history/{id}/*.md`
 * inline (core/src/gui/routes/alerts.ts:317-333). This helper is a small,
 * independent read-only utility for the Home/AI-usage activity metrics —
 * it does not touch or refactor the existing route.
 *
 * Filenames follow the convention written by AlertService.saveToHistory
 * (core/src/services/alerts/index.ts:668-670): `${YYYY-MM-DD}_${HH-mm-ss-SSS}.md`.
 * The leading 10 characters of the filename are the UTC date.
 */
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface CountAlertFiringsByDayOpts {
	/** ISO8601 inclusive lower bound on the file's date prefix. */
	sinceIso: string;
	/** When provided, only count history for these alert ids. Omit to count all. */
	alertIds?: string[];
}

export interface DailyAlertFiringCount {
	date: string; // YYYY-MM-DD
	count: number;
}

const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})_/;

/**
 * Count alert-history `.md` files by day (UTC, YYYY-MM-DD), since a given
 * timestamp. A missing alert-history directory yields an empty result, not
 * an error — history simply hasn't accumulated yet.
 */
export async function countAlertFiringsByDay(
	dataDir: string,
	opts: CountAlertFiringsByDayOpts,
): Promise<DailyAlertFiringCount[]> {
	const historyRoot = resolve(dataDir, 'system', 'alert-history');
	const sinceDate = opts.sinceIso.slice(0, 10);

	let alertDirs: string[];
	try {
		alertDirs = await readdir(historyRoot);
	} catch {
		return [];
	}

	if (opts.alertIds) {
		const allowed = new Set(opts.alertIds);
		alertDirs = alertDirs.filter((id) => allowed.has(id));
	}

	const counts = new Map<string, number>();

	for (const alertId of alertDirs) {
		let files: string[];
		try {
			files = await readdir(join(historyRoot, alertId));
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith('.md')) continue;
			const match = file.match(DATE_PREFIX_RE);
			if (!match) continue;
			const date = match[1] as string;
			if (date < sinceDate) continue;
			counts.set(date, (counts.get(date) ?? 0) + 1);
		}
	}

	return [...counts.entries()]
		.map(([date, count]) => ({ date, count }))
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
