/**
 * Data-query context formatting helpers (D2b/D2c).
 *
 * Format DataQueryService results and recent InteractionContext entries
 * into compact strings for system-prompt injection.
 */

import type { DataQueryResult } from '../../types/data-query.js';
import { formatRelativeTime } from '../../utils/cron-describe.js';
import type { InteractionEntry } from '../interaction-context/index.js';
import { sanitizeInput } from '../prompt-assembly/index.js';

/**
 * Format a DataQueryResult into a string for injection into the system prompt.
 *
 * Note: DataQueryService sanitizes metadata fields (title, tags, entities) but
 * NOT file body content. The caller must sanitize the returned string before
 * prompt injection.
 */
export function formatDataQueryContext(result: DataQueryResult): string {
	const parts: string[] = [];
	for (const file of result.files) {
		const header = [file.appId, file.type, file.title].filter(Boolean).join(' / ');
		parts.push(`[${header}]\n${file.content}`);
	}
	return parts.join('\n\n');
}

/**
 * Format recent interaction entries as a concise summary string for classifier injection.
 *
 * Example output: "receipt_captured (food, 2m ago), recipe_saved (food, 7m ago)"
 *
 * @param entries  Recent interaction entries (newest-first from getRecent()).
 * @param now      Reference time for relative timestamps (injectable for testing).
 */
export function formatInteractionContextSummary(
	entries: InteractionEntry[],
	now: Date = new Date(),
): string {
	if (entries.length === 0) return '';
	return entries
		.map((e) => {
			const relTime = formatRelativeTime(new Date(e.timestamp), now);
			return `${sanitizeInput(e.action, 100)} (${sanitizeInput(e.appId, 50)}, ${relTime})`;
		})
		.join(', ');
}

/**
 * Extract and deduplicate all filePaths from a list of interaction entries.
 * Returns a flat, unique array of data-root-relative file paths.
 */
export function extractRecentFilePaths(entries: InteractionEntry[]): string[] {
	const seen = new Set<string>();
	for (const entry of entries) {
		for (const path of entry.filePaths ?? []) {
			seen.add(path);
		}
	}
	return [...seen];
}
