import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ReportDefinition } from '../../../types/report.js';
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
		id: 'test-report',
		name: 'Test Report',
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

describe('validateReport — space_id validation', () => {
	const userManager = makeUserManager();

	it('validates valid space_id format', () => {
		const report = makeValidReport({
			sections: [
				{
					type: 'app-data',
					label: 'Space Data',
					config: { app_id: 'notes', path: 'list.md', space_id: 'family' },
				},
			],
		});
		const errors = validateReport(report, userManager);
		const spaceErrors = errors.filter(
			(e) => e.field.includes('space_id') || e.field.includes('user_id'),
		);
		expect(spaceErrors).toEqual([]);
	});

	it('rejects path-traversal space_id', () => {
		const report = makeValidReport({
			sections: [
				{
					type: 'app-data',
					label: 'Space Data',
					config: {
						app_id: 'notes',
						user_id: '123456789',
						path: 'list.md',
						space_id: '../../evil',
					},
				},
			],
		});
		const errors = validateReport(report, userManager);
		expect(errors.some((e) => e.field.includes('space_id'))).toBe(true);
	});

	it('rejects uppercase space_id', () => {
		const report = makeValidReport({
			sections: [
				{
					type: 'app-data',
					label: 'Space Data',
					config: {
						app_id: 'notes',
						user_id: '123456789',
						path: 'list.md',
						space_id: 'INVALID',
					},
				},
			],
		});
		const errors = validateReport(report, userManager);
		expect(errors.some((e) => e.field.includes('space_id'))).toBe(true);
	});

	it('allows missing user_id when space_id is set', () => {
		const report = makeValidReport({
			sections: [
				{
					type: 'app-data',
					label: 'Space Data',
					config: { app_id: 'notes', path: 'list.md', space_id: 'family' },
				},
			],
		});
		const errors = validateReport(report, userManager);
		expect(errors.some((e) => e.field.includes('user_id'))).toBe(false);
	});

	it('requires user_id when space_id is not set', () => {
		const report = makeValidReport({
			sections: [
				{
					type: 'app-data',
					label: 'Space Data',
					config: { app_id: 'notes', path: 'list.md' },
				},
			],
		});
		const errors = validateReport(report, userManager);
		expect(errors.some((e) => e.field.includes('user_id'))).toBe(true);
	});

	it('allows both user_id and space_id together', () => {
		const report = makeValidReport({
			sections: [
				{
					type: 'app-data',
					label: 'Space Data',
					config: {
						app_id: 'notes',
						user_id: '123456789',
						path: 'list.md',
						space_id: 'family',
					},
				},
			],
		});
		const errors = validateReport(report, userManager);
		const relevantErrors = errors.filter(
			(e) => e.field.includes('space_id') || e.field.includes('user_id'),
		);
		expect(relevantErrors).toEqual([]);
	});
});
