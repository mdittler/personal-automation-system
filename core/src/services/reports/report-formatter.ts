/**
 * Report formatter.
 *
 * Assembles collected sections and an optional LLM summary
 * into a formatted markdown report.
 */

import type { CollectedSection, ReportDefinition } from '../../types/report.js';
import { escapeMarkdown } from '../../utils/escape-markdown.js';

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
 *
 * This is a pure truncation helper — it does NOT escape content.
 * Use formatReportForTelegram() for full Telegram-safe report formatting.
 */
export function formatForTelegram(markdown: string): string {
	const maxLength = 4000; // Leave margin for truncation notice
	if (markdown.length <= maxLength) {
		return markdown;
	}
	return `${markdown.slice(0, maxLength)}\n\n_...report truncated_`;
}

/**
 * Format a report for Telegram delivery with selective Markdown escaping.
 *
 * Escapes data-origin fields (name, description, section labels/content) to
 * prevent Telegram parse errors, while leaving LLM summaries and server-owned
 * formatting markers (headers, italics) unescaped.
 */
export function formatReportForTelegram(
	report: ReportDefinition,
	sections: CollectedSection[],
	summary?: string,
	runDate?: string,
): string {
	const lines: string[] = [];

	// Header — report.name is user-configured data
	lines.push(`# ${escapeMarkdown(report.name)}`);
	if (runDate) {
		lines.push(`_Generated: ${runDate}_`); // runDate is server-formatted — safe
	}
	if (report.description) {
		lines.push('', escapeMarkdown(report.description));
	}

	// LLM Summary — trusted formatter output, not escaped
	if (summary) {
		lines.push('', '## Summary', '', summary);
	}

	// Sections — labels and content are user/data-origin, escape them
	for (const section of sections) {
		lines.push('', `## ${escapeMarkdown(section.label)}`);
		if (section.isEmpty) {
			if (section.content) {
				lines.push('', `_${escapeMarkdown(section.content)}_`);
			}
		} else {
			lines.push('', escapeMarkdown(section.content));
		}
	}

	lines.push('');
	const text = lines.join('\n');

	// Truncate to Telegram limit; back up past any dangling backslash
	const maxLength = 4000;
	if (text.length <= maxLength) return text;
	let cutAt = maxLength;
	while (cutAt > 0 && text[cutAt - 1] === '\\') cutAt--;
	return `${text.slice(0, cutAt)}\n\n_...report truncated_`;
}
