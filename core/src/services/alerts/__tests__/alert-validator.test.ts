import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { AlertAction, AlertDataSource, AlertDefinition } from '../../../types/alert.js';
import { AppToggleStore } from '../../app-toggle/index.js';
import { UserManager } from '../../user-manager/index.js';
import { validateAlert } from '../alert-validator.js';

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

function makeValidAlert(overrides: Partial<AlertDefinition> = {}): AlertDefinition {
	return {
		id: 'grocery-check',
		name: 'Grocery List Check',
		description: 'Alert when grocery list is long',
		enabled: true,
		schedule: '0 18 * * *',
		condition: {
			type: 'deterministic',
			expression: 'line count > 5',
			data_sources: [{ app_id: 'grocery', user_id: '123456789', path: 'list.md' }],
		},
		actions: [
			{
				type: 'telegram_message',
				config: { message: 'Your grocery list has many items!' },
			},
		],
		delivery: ['123456789'],
		cooldown: '24 hours',
		...overrides,
	};
}

describe('validateAlert', () => {
	const userManager = makeUserManager();

	// --- Standard (happy path) ---

	it('accepts a valid alert definition', () => {
		const errors = validateAlert(makeValidAlert(), userManager);
		expect(errors).toEqual([]);
	});

	it('accepts alert with fuzzy condition', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'fuzzy',
					expression: 'The grocery list seems too long',
					data_sources: [{ app_id: 'grocery', user_id: '123456789', path: 'list.md' }],
				},
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	it('accepts alert with run_report action', () => {
		const errors = validateAlert(
			makeValidAlert({
				actions: [{ type: 'run_report', config: { report_id: 'daily-summary' } }],
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	it('accepts alert with multiple actions', () => {
		const errors = validateAlert(
			makeValidAlert({
				actions: [
					{ type: 'telegram_message', config: { message: 'Alert!' } },
					{ type: 'run_report', config: { report_id: 'daily-summary' } },
				],
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	it('accepts alert with multiple data sources', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [
						{ app_id: 'grocery', user_id: '123456789', path: 'list.md' },
						{ app_id: 'notes', user_id: '123456789', path: 'daily.md' },
					],
				},
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	// --- ID validation ---

	it('rejects missing ID', () => {
		const errors = validateAlert(makeValidAlert({ id: '' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'id' }));
	});

	it('rejects invalid ID pattern (uppercase)', () => {
		const errors = validateAlert(makeValidAlert({ id: 'MyAlert' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'id' }));
	});

	it('rejects ID starting with number', () => {
		const errors = validateAlert(makeValidAlert({ id: '1alert' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'id' }));
	});

	it('rejects ID exceeding max length', () => {
		const errors = validateAlert(makeValidAlert({ id: 'a'.repeat(51) }), userManager);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'id', message: expect.stringContaining('50') }),
		);
	});

	// --- Name validation ---

	it('rejects missing name', () => {
		const errors = validateAlert(makeValidAlert({ name: '' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'name' }));
	});

	it('rejects whitespace-only name', () => {
		const errors = validateAlert(makeValidAlert({ name: '   ' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'name' }));
	});

	it('rejects name exceeding max length', () => {
		const errors = validateAlert(makeValidAlert({ name: 'x'.repeat(101) }), userManager);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'name', message: expect.stringContaining('100') }),
		);
	});

	// --- Schedule validation ---

	it('rejects missing schedule', () => {
		const errors = validateAlert(makeValidAlert({ schedule: '' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'schedule' }));
	});

	it('rejects invalid cron expression', () => {
		const errors = validateAlert(makeValidAlert({ schedule: 'not-a-cron' }), userManager);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'schedule', message: 'Invalid cron expression' }),
		);
	});

	// --- Delivery validation ---

	it('rejects empty delivery array', () => {
		const errors = validateAlert(makeValidAlert({ delivery: [] }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'delivery' }));
	});

	it('rejects unregistered user ID in delivery', () => {
		const errors = validateAlert(makeValidAlert({ delivery: ['999999999'] }), userManager);
		expect(errors).toContainEqual(
			expect.objectContaining({
				field: 'delivery',
				message: expect.stringContaining('999999999'),
			}),
		);
	});

	// --- Cooldown validation ---

	it('rejects missing cooldown', () => {
		const errors = validateAlert(makeValidAlert({ cooldown: '' }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'cooldown' }));
	});

	it('rejects unparseable cooldown', () => {
		const errors = validateAlert(makeValidAlert({ cooldown: 'whenever' }), userManager);
		expect(errors).toContainEqual(
			expect.objectContaining({
				field: 'cooldown',
				message: expect.stringContaining('Invalid cooldown'),
			}),
		);
	});

	it('accepts valid cooldown strings', () => {
		for (const cooldown of ['30 minutes', '1 hour', '24 hours', '7 days']) {
			const errors = validateAlert(makeValidAlert({ cooldown }), userManager);
			expect(errors).toEqual([]);
		}
	});

	// --- Condition validation ---

	it('rejects missing condition', () => {
		const errors = validateAlert(makeValidAlert({ condition: undefined as any }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'condition' }));
	});

	it('rejects invalid condition type', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'magic' as any,
					expression: 'test',
					data_sources: [{ app_id: 'a', user_id: '123456789', path: 'f.md' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'condition.type' }));
	});

	it('rejects empty condition expression', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: '',
					data_sources: [{ app_id: 'a', user_id: '123456789', path: 'f.md' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'condition.expression' }));
	});

	it('rejects empty data_sources array', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'condition.data_sources' }));
	});

	it('rejects exceeding max data sources', () => {
		const sources: AlertDataSource[] = Array.from({ length: 6 }, (_, i) => ({
			app_id: 'app',
			user_id: '123456789',
			path: `file${i}.md`,
		}));
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: sources,
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({
				field: 'condition.data_sources',
				message: expect.stringContaining('5'),
			}),
		);
	});

	// --- Data source validation ---

	it('rejects missing app_id in data source', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: '', user_id: '123456789', path: 'f.md' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'condition.data_sources[0].app_id' }),
		);
	});

	it('rejects invalid app_id pattern', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'MyApp', user_id: '123456789', path: 'f.md' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'condition.data_sources[0].app_id' }),
		);
	});

	it('rejects missing user_id in data source', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'app', user_id: '', path: 'f.md' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'condition.data_sources[0].user_id' }),
		);
	});

	it('rejects invalid user_id characters', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'app', user_id: '../etc', path: 'f.md' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'condition.data_sources[0].user_id' }),
		);
	});

	it('rejects path with ".."', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'app', user_id: '123456789', path: '../secret.md' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({
				field: 'condition.data_sources[0].path',
				message: expect.stringContaining('..'),
			}),
		);
	});

	it('rejects absolute path', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'app', user_id: '123456789', path: '/etc/passwd' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'condition.data_sources[0].path' }),
		);
	});

	it('rejects path with backslashes', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'app', user_id: '123456789', path: 'dir\\file.md' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'condition.data_sources[0].path' }),
		);
	});

	it('rejects missing path', () => {
		const errors = validateAlert(
			makeValidAlert({
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'app', user_id: '123456789', path: '' }],
				},
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'condition.data_sources[0].path' }),
		);
	});

	// --- Action validation ---

	it('rejects empty actions array', () => {
		const errors = validateAlert(makeValidAlert({ actions: [] }), userManager);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'actions' }));
	});

	it('rejects exceeding max actions', () => {
		const actions: AlertAction[] = Array.from({ length: 6 }, () => ({
			type: 'telegram_message' as const,
			config: { message: 'test' },
		}));
		const errors = validateAlert(makeValidAlert({ actions }), userManager);
		expect(errors).toContainEqual(
			expect.objectContaining({
				field: 'actions',
				message: expect.stringContaining('5'),
			}),
		);
	});

	it('rejects invalid action type', () => {
		const errors = validateAlert(
			makeValidAlert({
				actions: [{ type: 'email' as any, config: { to: 'me' } }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'actions[0].type' }));
	});

	it('rejects missing action config', () => {
		const errors = validateAlert(
			makeValidAlert({
				actions: [{ type: 'telegram_message', config: null as any }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'actions[0].config' }));
	});

	it('rejects telegram_message with empty message', () => {
		const errors = validateAlert(
			makeValidAlert({
				actions: [{ type: 'telegram_message', config: { message: '' } }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'actions[0].config.message' }));
	});

	it('rejects run_report with missing report_id', () => {
		const errors = validateAlert(
			makeValidAlert({
				actions: [{ type: 'run_report', config: { report_id: '' } }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'actions[0].config.report_id' }),
		);
	});

	it('rejects run_report with invalid report_id pattern', () => {
		const errors = validateAlert(
			makeValidAlert({
				actions: [{ type: 'run_report', config: { report_id: 'My Report' } }],
			}),
			userManager,
		);
		expect(errors).toContainEqual(
			expect.objectContaining({ field: 'actions[0].config.report_id' }),
		);
	});

	// --- Event trigger validation (C4, C6) ---

	it('accepts valid event-triggered alert', () => {
		const errors = validateAlert(
			makeValidAlert({
				schedule: undefined as any,
				trigger: { type: 'event', event_name: 'data:changed' },
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	it('accepts event names with colons, dots, hyphens, underscores', () => {
		for (const name of ['data:changed', 'schedule.completed', 'my-event', 'my_event', 'a']) {
			const errors = validateAlert(
				makeValidAlert({
					schedule: undefined as any,
					trigger: { type: 'event', event_name: name },
				}),
				userManager,
			);
			expect(errors.filter((e) => e.field === 'trigger.event_name')).toEqual([]);
		}
	});

	it('event trigger does not require schedule field', () => {
		const errors = validateAlert(
			makeValidAlert({
				schedule: undefined as any,
				trigger: { type: 'event', event_name: 'data:changed' },
			}),
			userManager,
		);
		expect(errors.filter((e) => e.field === 'schedule')).toEqual([]);
	});

	it('rejects empty event_name', () => {
		const errors = validateAlert(
			makeValidAlert({
				schedule: undefined as any,
				trigger: { type: 'event', event_name: '' },
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'trigger.event_name' }));
	});

	it('rejects whitespace-only event_name', () => {
		const errors = validateAlert(
			makeValidAlert({
				schedule: undefined as any,
				trigger: { type: 'event', event_name: '   ' },
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'trigger.event_name' }));
	});

	it('rejects event_name with spaces', () => {
		const errors = validateAlert(
			makeValidAlert({
				schedule: undefined as any,
				trigger: { type: 'event', event_name: 'data changed' },
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'trigger.event_name' }));
	});

	it('rejects event_name exceeding 100 characters', () => {
		const errors = validateAlert(
			makeValidAlert({
				schedule: undefined as any,
				trigger: { type: 'event', event_name: 'a'.repeat(101) },
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'trigger.event_name' }));
	});

	it('rejects event_name starting with special character', () => {
		const errors = validateAlert(
			makeValidAlert({
				schedule: undefined as any,
				trigger: { type: 'event', event_name: ':invalid' },
			}),
			userManager,
		);
		expect(errors).toContainEqual(expect.objectContaining({ field: 'trigger.event_name' }));
	});

	it('falls back to schedule validation for scheduled trigger type', () => {
		const errors = validateAlert(
			makeValidAlert({
				schedule: undefined as any,
				trigger: { type: 'scheduled', schedule: '0 9 * * *' },
			}),
			userManager,
		);
		expect(errors).toEqual([]);
	});

	// --- Multiple errors ---

	it('returns multiple errors for multiple invalid fields', () => {
		const errors = validateAlert(
			makeValidAlert({
				id: '',
				name: '',
				schedule: '',
				delivery: [],
				cooldown: '',
				actions: [],
			}),
			userManager,
		);
		expect(errors.length).toBeGreaterThanOrEqual(6);
	});
});
