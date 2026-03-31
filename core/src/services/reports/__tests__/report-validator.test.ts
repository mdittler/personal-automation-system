import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ReportDefinition, ReportSection } from '../../../types/report.js';
import { AppToggleStore } from '../../app-toggle/index.js';
import { UserManager } from '../../user-manager/index.js';
import { validateReport } from '../report-validator.js';

const logger = pino({ level: 'silent' });

function makeUserManager(userIds: string[] = ['123456789']): UserManager {
	return new UserManager({
		config: {
			users: userIds.map((id) => ({
				id,
				name: `User ${id}`,
				enabledApps: ['*'],
			})),
		} as any,
		appToggle: new AppToggleStore({ dataDir: '/tmp', logger }),
		logger,
	});
}

function makeValidReport(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
	return {
		id: 'weekly-summary',
		name: 'Weekly Summary',
		description: 'A weekly overview',
		enabled: true,
		schedule: '0 9 * * 1',
		delivery: ['123456789'],
		sections: [
			{
				type: 'custom',
				label: 'Intro',
				config: { text: 'Hello world' },
			},
		],
		llm: { enabled: false },
		...overrides,
	};
}

function makeSection(overrides: Partial<ReportSection> = {}): ReportSection {
	return {
		type: 'custom',
		label: 'Test',
		config: { text: 'some text' },
		...overrides,
	};
}

describe('validateReport', () => {
	const userManager = makeUserManager();

	// --- Standard (happy path) ---

	it('accepts a valid report definition', () => {
		const errors = validateReport(makeValidReport(), userManager);
		expect(errors).toEqual([]);
	});

	it('accepts a report with all section types', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{ type: 'changes', label: 'Changes', config: { lookback_hours: 48 } },
					{
						type: 'app-data',
						label: 'Notes',
						config: { app_id: 'notes', user_id: '123456789', path: 'daily-notes/2026-03-14.md' },
					},
					{ type: 'context', label: 'Context', config: { key_prefix: 'preferences' } },
					{ type: 'custom', label: 'Custom', config: { text: 'hello' } },
				],
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	it('accepts a report with LLM config', () => {
		const errors = validateReport(
			makeValidReport({
				llm: { enabled: true, tier: 'standard', max_tokens: 500, prompt: 'Summarize this.' },
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	// --- ID validation ---

	it('rejects empty ID', () => {
		const errors = validateReport(makeValidReport({ id: '' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'id' }));
	});

	it('rejects ID with uppercase letters', () => {
		const errors = validateReport(makeValidReport({ id: 'Weekly' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'id' }));
	});

	it('rejects ID starting with a digit', () => {
		const errors = validateReport(makeValidReport({ id: '1report' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'id' }));
	});

	it('rejects ID exceeding max length', () => {
		const errors = validateReport(makeValidReport({ id: 'a'.repeat(51) }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'id' }));
	});

	it('accepts ID at max length', () => {
		const errors = validateReport(makeValidReport({ id: 'a'.repeat(50) }), userManager);
		const idErrors = errors.filter((e) => e.field === 'id');
		expect(idErrors).toEqual([]);
	});

	// --- Name validation ---

	it('rejects empty name', () => {
		const errors = validateReport(makeValidReport({ name: '' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'name' }));
	});

	it('rejects whitespace-only name', () => {
		const errors = validateReport(makeValidReport({ name: '   ' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'name' }));
	});

	it('rejects name exceeding max length', () => {
		const errors = validateReport(makeValidReport({ name: 'x'.repeat(101) }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'name' }));
	});

	// --- Schedule validation ---

	it('rejects empty schedule', () => {
		const errors = validateReport(makeValidReport({ schedule: '' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'schedule' }));
	});

	it('rejects invalid cron expression', () => {
		const errors = validateReport(makeValidReport({ schedule: 'not a cron' }), userManager);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'schedule', message: 'Invalid cron expression' }),
		);
	});

	// --- Delivery validation ---

	it('rejects empty delivery array', () => {
		const errors = validateReport(makeValidReport({ delivery: [] }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'delivery' }));
	});

	it('rejects unregistered user ID in delivery', () => {
		const errors = validateReport(makeValidReport({ delivery: ['999999'] }), userManager);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'delivery', message: expect.stringContaining('999999') }),
		);
	});

	it('accepts registered user IDs', () => {
		const errors = validateReport(makeValidReport({ delivery: ['123456789'] }), userManager);
		const deliveryErrors = errors.filter((e) => e.field === 'delivery');
		expect(deliveryErrors).toEqual([]);
	});

	// --- Sections validation ---

	it('rejects empty sections array', () => {
		const errors = validateReport(makeValidReport({ sections: [] }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections' }));
	});

	it('rejects exceeding max sections', () => {
		const sections = Array.from({ length: 21 }, (_, i) => makeSection({ label: `Section ${i}` }));
		const errors = validateReport(makeValidReport({ sections }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections' }));
	});

	it('rejects invalid section type', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [{ type: 'invalid' as any, label: 'Bad', config: {} }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].type' }));
	});

	it('rejects section with empty label', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [makeSection({ label: '' })],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].label' }));
	});

	// --- Changes section config ---

	it('rejects negative lookback_hours', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [{ type: 'changes', label: 'Changes', config: { lookback_hours: -1 } }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'sections[0].config.lookback_hours' }),
		);
	});

	it('accepts changes section with defaults', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [{ type: 'changes', label: 'Changes', config: {} }],
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	// --- App-data section config ---

	it('rejects app-data with missing app_id', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{
						type: 'app-data',
						label: 'Data',
						config: { app_id: '', user_id: '123456789', path: 'file.md' },
					},
				],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config.app_id' }));
	});

	it('rejects app-data with invalid app_id format', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{
						type: 'app-data',
						label: 'Data',
						config: { app_id: 'Bad-App', user_id: '123456789', path: 'file.md' },
					},
				],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config.app_id' }));
	});

	it('rejects app-data with path traversal (..)', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{
						type: 'app-data',
						label: 'Data',
						config: { app_id: 'notes', user_id: '123456789', path: '../../../etc/passwd' },
					},
				],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config.path' }));
	});

	it('rejects app-data with absolute path', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{
						type: 'app-data',
						label: 'Data',
						config: { app_id: 'notes', user_id: '123456789', path: '/etc/passwd' },
					},
				],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config.path' }));
	});

	it('rejects app-data with backslashes', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{
						type: 'app-data',
						label: 'Data',
						config: { app_id: 'notes', user_id: '123456789', path: 'notes\\file.md' },
					},
				],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config.path' }));
	});

	it('rejects app-data with path traversal in user_id', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{
						type: 'app-data',
						label: 'Data',
						config: { app_id: 'notes', user_id: '../../system', path: 'file.md' },
					},
				],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config.user_id' }));
	});

	it('rejects app-data with special characters in user_id', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{
						type: 'app-data',
						label: 'Data',
						config: { app_id: 'notes', user_id: 'user/evil', path: 'file.md' },
					},
				],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config.user_id' }));
	});

	it('rejects app-data with missing path', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{
						type: 'app-data',
						label: 'Data',
						config: { app_id: 'notes', user_id: '123456789', path: '' },
					},
				],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config.path' }));
	});

	it('accepts valid app-data with date token', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [
					{
						type: 'app-data',
						label: 'Data',
						config: { app_id: 'notes', user_id: '123456789', path: 'daily-notes/{today}.md' },
					},
				],
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	// --- Context section config ---

	it('rejects context with empty key_prefix', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [{ type: 'context', label: 'Ctx', config: { key_prefix: '' } }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'sections[0].config.key_prefix' }),
		);
	});

	// --- Custom section config ---

	it('rejects custom with empty text', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [{ type: 'custom', label: 'Custom', config: { text: '' } }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config.text' }));
	});

	// --- LLM config validation ---

	it('rejects invalid LLM tier', () => {
		const errors = validateReport(
			makeValidReport({ llm: { enabled: true, tier: 'turbo' as any } }),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'llm.tier' }));
	});

	it('rejects zero max_tokens', () => {
		const errors = validateReport(
			makeValidReport({ llm: { enabled: true, max_tokens: 0 } }),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'llm.max_tokens' }));
	});

	it('rejects negative max_tokens', () => {
		const errors = validateReport(
			makeValidReport({ llm: { enabled: true, max_tokens: -10 } }),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'llm.max_tokens' }));
	});

	it('rejects max_tokens exceeding limit', () => {
		const errors = validateReport(
			makeValidReport({ llm: { enabled: true, max_tokens: 3000 } }),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'llm.max_tokens' }));
	});

	it('accepts max_tokens at limit', () => {
		const errors = validateReport(
			makeValidReport({ llm: { enabled: true, max_tokens: 2000 } }),
			userManager,
		);
		const llmErrors = errors.filter((e) => e.field.startsWith('llm'));
		expect(llmErrors).toEqual([]);
	});

	it('rejects non-integer max_tokens', () => {
		const errors = validateReport(
			makeValidReport({ llm: { enabled: true, max_tokens: 1.5 } }),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'llm.max_tokens' }));
	});

	// --- Multiple errors ---

	it('reports multiple errors simultaneously', () => {
		const errors = validateReport(
			makeValidReport({
				id: '',
				name: '',
				schedule: 'bad',
				delivery: [],
				sections: [],
			}),
			userManager,
		);
		expect(errors.length).toBeGreaterThanOrEqual(4);
	});

	// --- Section config missing ---

	it('rejects section with null config', () => {
		const errors = validateReport(
			makeValidReport({
				sections: [{ type: 'custom', label: 'Test', config: null as any }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'sections[0].config' }));
	});
});
