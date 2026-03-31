/**
 * Report formatter.
 *
 * Assembles collected sections and an optional LLM summary
 * into a formatted markdown report.
 */

import type { CollectedSection, ReportDefinition } from '../../types/report.js';

/**
 * Format a report as markdown.
 *
 * @param report - The report definition (for name, description)
 * @param sections - Collected section data
 * @param summary - Optional LLM-generated summary
 * @param runDate - Formatted date string for the report header
 */
export function formatReport(
	report: ReportDefinition,
	sections: CollectedSection[],
	summary?: string,
	runDate?: string,
): string {
	const lines: string[] = [];

	// Header
	lines.push(`# ${report.name}`);
	if (runDate) {
		lines.push(`_Generated: ${runDate}_`);
	}
	if (report.description) {
		lines.push('', report.description);
	}

	// LLM Summary (if provided, show first)
	if (summary) {
		lines.push('', '## Summary', '', summary);
	}

	// Sections
	for (const section of sections) {
		lines.push('', `## ${section.label}`);
		if (section.isEmpty) {
			lines.push('', `_${section.content}_`);
		} else {
			lines.push('', section.content);
		}
	}

	lines.push('');
	return lines.join('\n');
}

/**
 * Format a report for Telegram delivery.
 *
 * Telegram has a 4096-character limit per message. If the report exceeds
 * this, it is truncated with a note.
 */
export function formatForTelegram(markdown: string): string {
	const maxLength = 4000; // Leave margin for truncation notice
	if (markdown.length <= maxLength) {
		return markdown;
	}
	return `${markdown.slice(0, maxLength)}\n\n_...report truncated_`;
}
