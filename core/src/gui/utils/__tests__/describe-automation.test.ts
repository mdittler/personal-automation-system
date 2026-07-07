/**
 * Human-readable review sentences for reports/alerts (Batch 3 Task 3.2,
 * Batch 4 Task 4.2). `describeReport`/`describeAlert` are deterministic
 * string assembly from the definition + the existing `describeCron` helper
 * + `humanizeLabel` for enum-ish fields — no LLM involvement. The returned
 * string is plain text; callers (templates) are responsible for escaping
 * with `<%= %>`.
 */
import { describe, expect, it } from 'vitest';
import type { AlertDefinition } from '../../../types/alert.js';
import type { ReportDefinition } from '../../../types/report.js';
import { describeCron } from '../../../utils/cron-describe.js';
import { describeAlert, describeReport } from '../describe-automation.js';

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

function baseAlert(overrides: Partial<AlertDefinition> = {}): AlertDefinition {
	return {
		id: 'pantry-check',
		name: 'Pantry Check',
		enabled: true,
		schedule: '0 7 * * *',
		trigger: { type: 'scheduled', schedule: '0 7 * * *' },
		condition: {
			type: 'deterministic',
			expression: 'contains "expired"',
			data_sources: [{ app_id: 'food', user_id: 'u1', path: 'pantry/items.md' }],
		},
		actions: [{ type: 'telegram_message', config: { message: 'Check the pantry!' } }],
		delivery: ['u1'],
		cooldown: '4 hours',
		...overrides,
	};
}

describe('describeAlert', () => {
	it('renders a scheduled deterministic alert in plain language', () => {
		const sentence = describeAlert(baseAlert());
		expect(sentence).toContain(describeCron('0 7 * * *'));
		expect(sentence).toMatch(/mentions "expired"/);
		expect(sentence).toMatch(/Telegram message/);
		expect(sentence).toContain("Won't repeat within 4 hours.");
	});

	it('renders an event-triggered fuzzy alert in plain language', () => {
		const sentence = describeAlert(
			baseAlert({
				trigger: { type: 'event', event_name: 'data:changed' },
				schedule: '',
				condition: {
					type: 'fuzzy',
					expression: 'anything about to spoil',
					data_sources: [{ app_id: 'food', user_id: 'u1', path: 'pantry/items.md' }],
				},
			}),
		);
		expect(sentence).toMatch(/^When data changes/);
		expect(sentence).toMatch(/the AI judges "anything about to spoil"/);
	});

	it('uses app id + file basename (no extension, no full path) for data sources', () => {
		const sentence = describeAlert(
			baseAlert({
				condition: {
					type: 'deterministic',
					expression: 'is empty',
					data_sources: [{ app_id: 'food', user_id: 'u1', path: 'pantry/items.md' }],
				},
			}),
		);
		expect(sentence).toContain('Food items');
		expect(sentence).not.toContain('pantry/items.md');
		expect(sentence).not.toContain('.md');
	});

	it('renders plain-language deterministic condition phrasing for all six rule-builder patterns', () => {
		const withExpr = (expression: string) =>
			describeAlert(
				baseAlert({ condition: { type: 'deterministic', expression, data_sources: [] } }),
			);
		expect(withExpr('is empty')).toMatch(/it's empty/);
		expect(withExpr('is not empty')).toMatch(/it has anything in it/);
		expect(withExpr('contains "milk"')).toMatch(/it mentions "milk"/);
		expect(withExpr('not contains "milk"')).toMatch(/doesn't mention "milk"/);
		expect(withExpr('line count > 10')).toMatch(/more than 10 lines/);
		expect(withExpr('line count < 3')).toMatch(/fewer than 3 lines/);
	});

	it('falls back to the raw expression for a legacy/unmappable deterministic expression', () => {
		const sentence = describeAlert(
			baseAlert({
				condition: { type: 'deterministic', expression: 'some legacy free text', data_sources: [] },
			}),
		);
		expect(sentence).toMatch(/it some legacy free text/);
	});

	it('preserves the "Telegram" proper-noun capitalization in action text', () => {
		const sentence = describeAlert(baseAlert());
		expect(sentence).toContain('Telegram');
		expect(sentence).not.toContain('telegram message');
	});

	it('omits cooldown language when cooldown is empty', () => {
		const sentence = describeAlert(baseAlert({ cooldown: '' }));
		expect(sentence).not.toMatch(/Won't repeat/);
	});

	it('handles zero actions and zero data sources without throwing', () => {
		const sentence = describeAlert(
			baseAlert({
				actions: [],
				condition: { type: 'deterministic', expression: 'is empty', data_sources: [] },
			}),
		);
		expect(typeof sentence).toBe('string');
		expect(sentence.length).toBeGreaterThan(0);
		expect(sentence).toMatch(/your data/);
		expect(sentence).toMatch(/do nothing yet/);
	});

	it('returns plain text — no HTML — leaving escaping to the template', () => {
		const sentence = describeAlert(baseAlert({ name: '<b>x</b>' }));
		expect(typeof sentence).toBe('string');
	});

	it('does not throw for a structurally-invalid definition missing condition/actions/trigger', () => {
		// Mirrors a malformed alerts/*.yaml loaded from disk (id/name/enabled
		// only) — the GUI lists these with a validation-error badge; the
		// sentence must render alongside it, not throw a 500.
		const partial = {
			id: 'bad-alert',
			name: 'Bad Alert',
			enabled: true,
		} as unknown as AlertDefinition;
		expect(() => describeAlert(partial)).not.toThrow();
		const sentence = describeAlert(partial);
		expect(typeof sentence).toBe('string');
		expect(sentence.length).toBeGreaterThan(0);
	});
});
