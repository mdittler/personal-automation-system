import { describe, expect, it } from 'vitest';
import type { CollectedSection, ReportDefinition } from '../../../types/report.js';
import { formatForTelegram, formatReport, formatReportForTelegram } from '../report-formatter.js';

function makeReport(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
	return {
		id: 'test-report',
		name: 'Test Report',
		description: 'A test report',
		enabled: true,
		schedule: '0 9 * * 1',
		delivery: ['123'],
		sections: [],
		llm: { enabled: false },
		...overrides,
	};
}

describe('formatReport', () => {
	it('formats a report with header and sections', () => {
		const sections: CollectedSection[] = [
			{ label: 'Changes', content: '- wrote file.md', isEmpty: false },
			{ label: 'Notes', content: 'Some notes here', isEmpty: false },
		];

		const result = formatReport(makeReport(), sections, undefined, 'Mar 14, 2026');

		expect(result).toContain('# Test Report');
		expect(result).toContain('_Generated: Mar 14, 2026_');
		expect(result).toContain('A test report');
		expect(result).toContain('## Changes');
		expect(result).toContain('- wrote file.md');
		expect(result).toContain('## Notes');
	});

	it('includes LLM summary before sections', () => {
		const sections: CollectedSection[] = [{ label: 'Data', content: 'some data', isEmpty: false }];

		const result = formatReport(makeReport(), sections, 'This week was productive.');

		expect(result).toContain('## Summary');
		expect(result).toContain('This week was productive.');
		// Summary should come before Data section
		const summaryIndex = result.indexOf('## Summary');
		const dataIndex = result.indexOf('## Data');
		expect(summaryIndex).toBeLessThan(dataIndex);
	});

	it('formats empty sections in italics', () => {
		const sections: CollectedSection[] = [
			{ label: 'Empty Section', content: 'No data available.', isEmpty: true },
		];

		const result = formatReport(makeReport(), sections);

		expect(result).toContain('_No data available._');
	});

	it('omits description when not set', () => {
		const result = formatReport(makeReport({ description: undefined }), [
			{ label: 'Sec', content: 'data', isEmpty: false },
		]);

		// Should go straight from header to section
		expect(result).toContain('# Test Report');
		expect(result).toContain('## Sec');
	});

	it('omits generated date when not provided', () => {
		const result = formatReport(makeReport(), []);
		expect(result).not.toContain('_Generated:');
	});

	it('handles zero sections', () => {
		const result = formatReport(makeReport(), []);
		expect(result).toContain('# Test Report');
		// Should still be valid markdown
		expect(result.trim()).toBeTruthy();
	});

	it('omits summary section when no summary provided', () => {
		const result = formatReport(makeReport(), [
			{ label: 'Data', content: 'stuff', isEmpty: false },
		]);

		expect(result).not.toContain('## Summary');
	});

	it('formats multiple sections in order', () => {
		const sections: CollectedSection[] = [
			{ label: 'First', content: 'aaa', isEmpty: false },
			{ label: 'Second', content: 'bbb', isEmpty: false },
			{ label: 'Third', content: 'ccc', isEmpty: false },
		];

		const result = formatReport(makeReport(), sections);

		const firstIdx = result.indexOf('## First');
		const secondIdx = result.indexOf('## Second');
		const thirdIdx = result.indexOf('## Third');
		expect(firstIdx).toBeLessThan(secondIdx);
		expect(secondIdx).toBeLessThan(thirdIdx);
	});
});

describe('formatReportForTelegram', () => {
	it('escapes data fields: report name, description, section label, section content', () => {
		const sections: CollectedSection[] = [
			{ label: 'Data [section]', content: 'Price is *high*', isEmpty: false },
		];

		const result = formatReportForTelegram(
			makeReport({ name: 'Budget *Report*', description: 'Covers [all] categories' }),
			sections,
		);

		expect(result).toContain('\\*Report\\*');
		expect(result).toContain('Covers \\[all\\] categories');
		expect(result).toContain('Data \\[section\\]');
		expect(result).toContain('Price is \\*high\\*');
	});

	it('does NOT escape LLM summary', () => {
		const sections: CollectedSection[] = [
			{ label: 'Data', content: 'some data', isEmpty: false },
		];
		const summary = '*Bold* summary from _LLM_';

		const result = formatReportForTelegram(makeReport(), sections, summary);

		// LLM summary is trusted formatter output — preserved as-is
		expect(result).toContain('*Bold* summary from _LLM_');
		expect(result).not.toContain('\\*Bold\\*');
	});

	it('does not affect formatReport output (unescaped canonical markdown)', () => {
		const sections: CollectedSection[] = [
			{ label: 'Data', content: 'Price is *high*', isEmpty: false },
		];
		const markdown = formatReport(makeReport({ name: 'Budget *Report*' }), sections);

		// formatReport is for history/API — must stay unescaped
		expect(markdown).toContain('Budget *Report*');
		expect(markdown).toContain('Price is *high*');
	});

	it('truncates long reports and does not split escape sequences', () => {
		// Section content with special chars — after escaping adds backslashes,
		// pushing the total past 4000 chars
		const filler = 'x'.repeat(3990);
		const sections: CollectedSection[] = [
			{ label: 'S', content: filler + ' *end*', isEmpty: false },
		];

		const result = formatReportForTelegram(makeReport({ name: 'R', description: undefined }), sections);

		expect(result).toContain('...report truncated');
		// The content just before the truncation notice must not end with a lone backslash
		const beforeNotice = result.split('\n\n_...report truncated_')[0] ?? '';
		expect(beforeNotice).not.toMatch(/\\$/);
	});

	it('formatForTelegram remains a pure truncation helper (no escaping)', () => {
		const msg = 'Data with *asterisks* and _underscores_';
		// formatForTelegram must NOT escape — it is used for other purposes
		expect(formatForTelegram(msg)).toBe(msg);
	});
});

describe('formatForTelegram', () => {
	it('returns short messages unchanged', () => {
		const msg = 'Hello world';
		expect(formatForTelegram(msg)).toBe(msg);
	});

	it('truncates messages exceeding 4000 chars', () => {
		const msg = 'x'.repeat(5000);
		const result = formatForTelegram(msg);
		expect(result.length).toBeLessThan(5000);
		expect(result).toContain('...report truncated');
	});

	it('preserves messages at exactly 4000 chars', () => {
		const msg = 'x'.repeat(4000);
		expect(formatForTelegram(msg)).toBe(msg);
	});
});
