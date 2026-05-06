/**
 * Unit tests for formatReportLines / formatAlertLines helpers.
 */

import { describe, expect, it } from 'vitest';
import type { AlertDefinition } from '../../../types/alert.js';
import type { ReportDefinition } from '../../../types/report.js';
import { formatAlertLines, formatReportLines } from '../reports-alerts-format.js';

function makeReport(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
	return {
		id: 'r1',
		name: 'Daily Summary',
		enabled: true,
		schedule: '0 0 * * *',
		delivery: [],
		sections: [],
		llm: { enabled: false } as ReportDefinition['llm'],
		...overrides,
	} as ReportDefinition;
}

function makeAlert(overrides: Partial<AlertDefinition> = {}): AlertDefinition {
	return {
		id: 'a1',
		name: 'Price Alert',
		enabled: true,
		conditions: [],
		actions: [],
		trigger: { type: 'scheduled', schedule: '0 * * * *' },
		...overrides,
	} as AlertDefinition;
}

// ─── formatReportLines ────────────────────────────────────────────────────────

describe('formatReportLines', () => {
	it('returns empty string for empty array', () => {
		expect(formatReportLines([])).toBe('');
	});

	it('formats a single report as "- name (schedule)"', () => {
		const r = makeReport({ name: 'Daily Summary', schedule: '0 0 * * *' });
		expect(formatReportLines([r])).toBe('- Daily Summary (0 0 * * *)');
	});

	it('joins multiple reports with \\n, no trailing newline', () => {
		const r1 = makeReport({ name: 'Daily', schedule: '0 0 * * *' });
		const r2 = makeReport({ name: 'Weekly', schedule: '0 0 * * 1' });
		const result = formatReportLines([r1, r2]);
		expect(result).toBe('- Daily (0 0 * * *)\n- Weekly (0 0 * * 1)');
		expect(result.endsWith('\n')).toBe(false);
	});
});

// ─── formatAlertLines ────────────────────────────────────────────────────────

describe('formatAlertLines', () => {
	it('returns empty string for empty array', () => {
		expect(formatAlertLines([])).toBe('');
	});

	it('formats a single alert as "- name"', () => {
		const a = makeAlert({ name: 'Price Alert' });
		expect(formatAlertLines([a])).toBe('- Price Alert');
	});

	it('joins multiple alerts with \\n, no trailing newline', () => {
		const a1 = makeAlert({ name: 'Price Alert' });
		const a2 = makeAlert({ name: 'Stock Alert' });
		const result = formatAlertLines([a1, a2]);
		expect(result).toBe('- Price Alert\n- Stock Alert');
		expect(result.endsWith('\n')).toBe(false);
	});
});
