/**
 * Human-readable review sentences for reports/alerts (Batch 3 Task 3.2,
 * Batch 4 Task 4.2). `describeReport`/`describeAlert` are deterministic
 * string assembly from the definition + the existing `describeCron` helper
 * + `humanizeLabel` for enum-ish fields — no LLM involvement. The returned
 * string is plain text; callers (templates) are responsible for escaping
 * with `<%= %>`.
 */
import { describe, expect, it } from 'vitest';
import type { ReportDefinition } from '../../../types/report.js';
import { describeCron } from '../../../utils/cron-describe.js';
import { describeReport } from '../describe-automation.js';

function baseReport(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
	return {
		id: 'daily-summary',
		name: 'Daily Summary',
		enabled: true,
		schedule: '0 7 * * *',
		delivery: ['123'],
		sections: [
			{ type: 'changes', label: 'Recent changes', config: { lookback_hours: 24 } },
			{ type: 'app-data', label: 'App data', config: { app_id: 'food', path: 'x.md' } },
		],
		llm: { enabled: false },
		...overrides,
	};
}

describe('describeReport', () => {
	it('embeds the real describeCron output for the schedule', () => {
		const sentence = describeReport(baseReport());
		expect(sentence).toContain(describeCron('0 7 * * *'));
	});

	it('lists section labels', () => {
		const sentence = describeReport(baseReport());
		expect(sentence).toContain('Recent changes');
		expect(sentence).toContain('App data');
	});

	it('mentions the AI summary when llm.enabled is true', () => {
		const sentence = describeReport(baseReport({ llm: { enabled: true } }));
		expect(sentence).toMatch(/AI summary/i);
	});

	it('omits AI summary language when llm.enabled is false', () => {
		const sentence = describeReport(baseReport({ llm: { enabled: false } }));
		expect(sentence).not.toMatch(/AI summary/i);
	});

	it('mentions Telegram delivery', () => {
		const sentence = describeReport(baseReport());
		expect(sentence).toMatch(/Telegram/);
	});

	it('handles a report with zero sections without throwing', () => {
		const sentence = describeReport(baseReport({ sections: [] }));
		expect(typeof sentence).toBe('string');
		expect(sentence.length).toBeGreaterThan(0);
	});

	it('handles an invalid/empty schedule gracefully', () => {
		const sentence = describeReport(baseReport({ schedule: '' }));
		expect(typeof sentence).toBe('string');
		expect(sentence.length).toBeGreaterThan(0);
	});

	it('returns plain text — no HTML — leaving escaping to the template', () => {
		const sentence = describeReport(
			baseReport({ sections: [{ type: 'custom', label: '<b>x</b>', config: { text: 'y' } }] }),
		);
		expect(sentence).toContain('<b>x</b>');
	});
});
