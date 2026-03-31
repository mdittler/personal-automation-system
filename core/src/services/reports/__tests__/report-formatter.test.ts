import { describe, expect, it } from 'vitest';
import type { CollectedSection, ReportDefinition } from '../../../types/report.js';
import { formatForTelegram, formatReport } from '../report-formatter.js';

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
