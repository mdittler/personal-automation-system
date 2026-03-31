import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { AlertDefinition } from '../../../types/alert.js';
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
		id: 'test-alert',
		name: 'Test Alert',
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
				config: { message: 'Alert fired!' },
			},
		],
		delivery: ['123456789'],
		cooldown: '24 hours',
		...overrides,
	};
}

describe('validateAlert — space_id validation', () => {
	const userManager = makeUserManager();

	it('validates valid space_id format', () => {
		const alert = makeValidAlert({
			condition: {
				type: 'deterministic',
				expression: 'is not empty',
				data_sources: [{ app_id: 'grocery', path: 'list.md', space_id: 'family' }],
			},
		});
		const errors = validateAlert(alert, userManager);
		// No space_id or user_id errors
		const spaceErrors = errors.filter(
			(e) => e.field.includes('space_id') || e.field.includes('user_id'),
		);
		expect(spaceErrors).toEqual([]);
	});

	it('rejects path-traversal space_id', () => {
		const alert = makeValidAlert({
			condition: {
				type: 'deterministic',
				expression: 'is not empty',
				data_sources: [
					{ app_id: 'grocery', user_id: '123456789', path: 'list.md', space_id: '../../evil' },
				],
			},
		});
		const errors = validateAlert(alert, userManager);
		expect(errors.some((e) => e.field.includes('space_id'))).toBe(true);
	});

	it('rejects uppercase space_id', () => {
		const alert = makeValidAlert({
			condition: {
				type: 'deterministic',
				expression: 'is not empty',
				data_sources: [
					{ app_id: 'grocery', user_id: '123456789', path: 'list.md', space_id: 'INVALID' },
				],
			},
		});
		const errors = validateAlert(alert, userManager);
		expect(errors.some((e) => e.field.includes('space_id'))).toBe(true);
	});

	it('allows missing user_id when space_id is set', () => {
		const alert = makeValidAlert({
			condition: {
				type: 'deterministic',
				expression: 'is not empty',
				data_sources: [{ app_id: 'grocery', path: 'list.md', space_id: 'family' }],
			},
		});
		const errors = validateAlert(alert, userManager);
		expect(errors.some((e) => e.field.includes('user_id'))).toBe(false);
	});

	it('requires user_id when space_id is not set', () => {
		const alert = makeValidAlert({
			condition: {
				type: 'deterministic',
				expression: 'is not empty',
				data_sources: [{ app_id: 'grocery', path: 'list.md' }],
			},
		});
		const errors = validateAlert(alert, userManager);
		expect(errors.some((e) => e.field.includes('user_id'))).toBe(true);
	});

	it('allows both user_id and space_id together', () => {
		const alert = makeValidAlert({
			condition: {
				type: 'deterministic',
				expression: 'is not empty',
				data_sources: [
					{ app_id: 'grocery', user_id: '123456789', path: 'list.md', space_id: 'family' },
				],
			},
		});
		const errors = validateAlert(alert, userManager);
		const relevantErrors = errors.filter(
			(e) => e.field.includes('space_id') || e.field.includes('user_id'),
		);
		expect(relevantErrors).toEqual([]);
	});
});
