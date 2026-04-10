import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertDefinition } from '../../../types/alert.js';
import type { LLMService } from '../../../types/llm.js';
import type { TelegramService } from '../../../types/telegram.js';
import { AppToggleStore } from '../../app-toggle/index.js';
import { CronManager } from '../../scheduler/cron-manager.js';
import { UserManager } from '../../user-manager/index.js';
import { AlertService, type AlertServiceOptions } from '../index.js';

const logger = pino({ level: 'silent' });

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-alert-spaces-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
	} as unknown as TelegramService;
}

function makeLLM(response = 'no'): LLMService {
	return {
		complete: vi.fn().mockResolvedValue(response),
		classify: vi.fn(),
		extractStructured: vi.fn(),
	} as unknown as LLMService;
}

function makeUserManager(): UserManager {
	return new UserManager({
		config: {
			users: [{ id: '123', name: 'Alice', enabledApps: ['*'] }],
		} as any,
		appToggle: new AppToggleStore({ dataDir: tempDir, logger }),
		logger,
	});
}

function makeReportService() {
	return {
		run: vi.fn().mockResolvedValue({
			reportId: 'test',
			markdown: '# Report',
			summarized: false,
			runAt: new Date().toISOString(),
		}),
	} as any;
}

function makeService(overrides: Partial<AlertServiceOptions> = {}): {
	service: AlertService;
	telegram: TelegramService;
} {
	const telegram = makeTelegram();
	const service = new AlertService({
		dataDir: tempDir,
		llm: makeLLM(),
		telegram,
		userManager: makeUserManager(),
		cronManager: new CronManager(logger, 'America/New_York', tempDir),
		reportService: makeReportService(),
		timezone: 'America/New_York',
		logger,
		...overrides,
	});
	return { service, telegram };
}

describe('AlertService — space data sources', () => {
	it('reads data from space directory when space_id is set', async () => {
		// Write data in space directory
		const spaceDir = join(tempDir, 'spaces', 'family', 'grocery');
		await mkdir(spaceDir, { recursive: true });
		await writeFile(join(spaceDir, 'list.md'), 'Item 1\nItem 2\nItem 3\nItem 4\nItem 5\nItem 6');

		const { service } = makeService();

		const def: AlertDefinition = {
			id: 'space-alert',
			name: 'Space Alert',
			enabled: true,
			schedule: '0 18 * * *',
			condition: {
				type: 'deterministic',
				expression: 'line count > 5',
				data_sources: [{ app_id: 'grocery', user_id: '123', path: 'list.md', space_id: 'family' }],
			},
			actions: [{ type: 'telegram_message', config: { message: 'Space alert fired!' } }],
			delivery: ['123'],
			cooldown: '24 hours',
		};

		const errors = await service.saveAlert(def);
		expect(errors).toEqual([]);

		const result = await service.evaluate('space-alert');
		expect(result.conditionMet).toBe(true);
		expect(result.actionTriggered).toBe(true);
	});

	it('reads data from user directory when space_id is not set (backward compat)', async () => {
		// Write data in user directory
		const userDir = join(tempDir, 'users', '123', 'grocery');
		await mkdir(userDir, { recursive: true });
		await writeFile(join(userDir, 'list.md'), 'Item 1\nItem 2\nItem 3\nItem 4\nItem 5\nItem 6');

		const { service } = makeService();

		const def: AlertDefinition = {
			id: 'user-alert',
			name: 'User Alert',
			enabled: true,
			schedule: '0 18 * * *',
			condition: {
				type: 'deterministic',
				expression: 'line count > 5',
				data_sources: [{ app_id: 'grocery', user_id: '123', path: 'list.md' }],
			},
			actions: [{ type: 'telegram_message', config: { message: 'User alert fired!' } }],
			delivery: ['123'],
			cooldown: '24 hours',
		};

		const errors = await service.saveAlert(def);
		expect(errors).toEqual([]);

		const result = await service.evaluate('user-alert');
		expect(result.conditionMet).toBe(true);
	});

	it('handles missing space data file gracefully', async () => {
		const { service } = makeService();

		const def: AlertDefinition = {
			id: 'missing-space',
			name: 'Missing Space Data',
			enabled: true,
			schedule: '0 18 * * *',
			condition: {
				type: 'deterministic',
				expression: 'is empty',
				data_sources: [
					{ app_id: 'grocery', user_id: '123', path: 'nonexistent.md', space_id: 'family' },
				],
			},
			actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
			delivery: ['123'],
			cooldown: '24 hours',
		};

		const errors = await service.saveAlert(def);
		expect(errors).toEqual([]);

		// Should not throw — handles missing file gracefully
		const result = await service.evaluate('missing-space');
		expect(result.conditionMet).toBe(true); // empty data satisfies "is empty"
	});

	it('rejects path traversal in space data source at validation', async () => {
		const { service } = makeService();

		const def: AlertDefinition = {
			id: 'traversal',
			name: 'Traversal Test',
			enabled: true,
			schedule: '0 18 * * *',
			condition: {
				type: 'deterministic',
				expression: 'is not empty',
				data_sources: [
					{
						app_id: 'grocery',
						user_id: '123',
						path: '../../../etc/passwd',
						space_id: 'family',
					},
				],
			},
			actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
			delivery: ['123'],
			cooldown: '24 hours',
		};

		const errors = await service.saveAlert(def);
		// Validator catches ".." in path
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]?.message).toContain('..');
	});
});
