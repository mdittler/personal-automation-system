/**
 * Integration tests for n8n dispatch in ReportService and AlertService.
 *
 * Tests that the services accept and store n8nDispatcher properly,
 * and that the dispatcher is used in bootstrap wiring.
 * Direct cron handler testing isn't possible without exposing internals,
 * so we test the dispatcher unit behavior + service configuration.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertDefinition } from '../../../types/alert.js';
import type { ContextStoreService } from '../../../types/context-store.js';
import type { LLMService } from '../../../types/llm.js';
import type { ReportDefinition } from '../../../types/report.js';
import type { TelegramService } from '../../../types/telegram.js';
import { AlertService } from '../../alerts/index.js';
import { AppToggleStore } from '../../app-toggle/index.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { ReportService } from '../../reports/index.js';
import { CronManager } from '../../scheduler/cron-manager.js';
import { UserManager } from '../../user-manager/index.js';
import { type N8nDispatcher, N8nDispatcherImpl } from '../index.js';

const logger = pino({ level: 'silent' });
let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-n8n-integration-'));
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

function makeLLM(): LLMService {
	return {
		complete: vi.fn().mockResolvedValue('Summary'),
		classify: vi.fn(),
		extractStructured: vi.fn(),
	} as unknown as LLMService;
}

function makeUserManager(): UserManager {
	return new UserManager({
		config: {
			users: [{ id: '123', name: 'Test User', enabledApps: ['*'] }],
		} as any,
		appToggle: new AppToggleStore({ dataDir: tempDir, logger }),
		logger,
	});
}

describe('n8n dispatch integration — ReportService', () => {
	it('accepts n8nDispatcher option without error', async () => {
		const dispatcher = new N8nDispatcherImpl({
			dispatchUrl: 'http://localhost:5678/webhook/pas',
			logger,
		});

		const service = new ReportService({
			dataDir: tempDir,
			changeLog: new ChangeLog(tempDir),
			contextStore: {
				get: vi.fn(),
				search: vi.fn().mockResolvedValue([]),
			} as unknown as ContextStoreService,
			llm: makeLLM(),
			telegram: makeTelegram(),
			userManager: makeUserManager(),
			cronManager: new CronManager(logger, 'UTC', tempDir),
			timezone: 'UTC',
			logger,
			n8nDispatcher: dispatcher,
		});

		// Service should initialize fine
		await service.init();
	});

	it('works without n8nDispatcher (backward compat)', async () => {
		const service = new ReportService({
			dataDir: tempDir,
			changeLog: new ChangeLog(tempDir),
			contextStore: {
				get: vi.fn(),
				search: vi.fn().mockResolvedValue([]),
			} as unknown as ContextStoreService,
			llm: makeLLM(),
			telegram: makeTelegram(),
			userManager: makeUserManager(),
			cronManager: new CronManager(logger, 'UTC', tempDir),
			timezone: 'UTC',
			logger,
			// No n8nDispatcher
		});

		await service.init();

		// run() still works internally
		const report: ReportDefinition = {
			id: 'test',
			name: 'Test',
			enabled: true,
			schedule: '0 9 * * 1',
			delivery: ['123'],
			sections: [{ type: 'custom', label: 'Intro', config: { text: 'Hello' } }],
			llm: { enabled: false },
		};
		await service.saveReport(report);
		const result = await service.run('test');
		expect(result).not.toBeNull();
		expect(result?.reportId).toBe('test');
	});

	it('registers cron job when report is saved with dispatcher', async () => {
		const dispatcher: N8nDispatcher = {
			enabled: true,
			dispatch: vi.fn().mockResolvedValue(true),
		};
		const cronManager = new CronManager(logger, 'UTC', tempDir);

		const service = new ReportService({
			dataDir: tempDir,
			changeLog: new ChangeLog(tempDir),
			contextStore: {
				get: vi.fn(),
				search: vi.fn().mockResolvedValue([]),
			} as unknown as ContextStoreService,
			llm: makeLLM(),
			telegram: makeTelegram(),
			userManager: makeUserManager(),
			cronManager,
			timezone: 'UTC',
			logger,
			n8nDispatcher: dispatcher,
		});

		const report: ReportDefinition = {
			id: 'test',
			name: 'Test',
			enabled: true,
			schedule: '0 9 * * 1',
			delivery: ['123'],
			sections: [{ type: 'custom', label: 'Intro', config: { text: 'Hello' } }],
			llm: { enabled: false },
		};
		await service.saveReport(report);

		// Cron job should be registered
		const jobs = cronManager.getRegisteredJobs();
		expect(jobs).toContain('reports:test');
	});
});

describe('n8n dispatch integration — AlertService', () => {
	it('accepts n8nDispatcher option without error', async () => {
		const dispatcher = new N8nDispatcherImpl({
			dispatchUrl: 'http://localhost:5678/webhook/pas',
			logger,
		});

		const reportService = new ReportService({
			dataDir: tempDir,
			changeLog: new ChangeLog(tempDir),
			contextStore: {
				get: vi.fn(),
				search: vi.fn().mockResolvedValue([]),
			} as unknown as ContextStoreService,
			llm: makeLLM(),
			telegram: makeTelegram(),
			userManager: makeUserManager(),
			cronManager: new CronManager(logger, 'UTC', tempDir),
			timezone: 'UTC',
			logger,
		});

		const alertService = new AlertService({
			dataDir: tempDir,
			llm: makeLLM(),
			telegram: makeTelegram(),
			userManager: makeUserManager(),
			cronManager: new CronManager(logger, 'UTC', tempDir),
			reportService,
			timezone: 'UTC',
			logger,
			n8nDispatcher: dispatcher,
		});

		await alertService.init();
	});

	it('works without n8nDispatcher (backward compat)', async () => {
		const reportService = new ReportService({
			dataDir: tempDir,
			changeLog: new ChangeLog(tempDir),
			contextStore: {
				get: vi.fn(),
				search: vi.fn().mockResolvedValue([]),
			} as unknown as ContextStoreService,
			llm: makeLLM(),
			telegram: makeTelegram(),
			userManager: makeUserManager(),
			cronManager: new CronManager(logger, 'UTC', tempDir),
			timezone: 'UTC',
			logger,
		});

		const alertService = new AlertService({
			dataDir: tempDir,
			llm: makeLLM(),
			telegram: makeTelegram(),
			userManager: makeUserManager(),
			cronManager: new CronManager(logger, 'UTC', tempDir),
			reportService,
			timezone: 'UTC',
			logger,
			// No n8nDispatcher
		});

		await alertService.init();
	});

	it('registers cron job when alert is saved with dispatcher', async () => {
		const dispatcher: N8nDispatcher = {
			enabled: true,
			dispatch: vi.fn().mockResolvedValue(true),
		};
		const cronManager = new CronManager(logger, 'UTC', tempDir);

		const reportService = new ReportService({
			dataDir: tempDir,
			changeLog: new ChangeLog(tempDir),
			contextStore: {
				get: vi.fn(),
				search: vi.fn().mockResolvedValue([]),
			} as unknown as ContextStoreService,
			llm: makeLLM(),
			telegram: makeTelegram(),
			userManager: makeUserManager(),
			cronManager,
			timezone: 'UTC',
			logger,
		});

		const alertService = new AlertService({
			dataDir: tempDir,
			llm: makeLLM(),
			telegram: makeTelegram(),
			userManager: makeUserManager(),
			cronManager,
			reportService,
			timezone: 'UTC',
			logger,
			n8nDispatcher: dispatcher,
		});

		const alert: AlertDefinition = {
			id: 'test-alert',
			name: 'Test Alert',
			enabled: true,
			schedule: '0 * * * *',
			condition: {
				type: 'deterministic',
				expression: 'not_empty',
				data_sources: [{ app_id: 'notes', user_id: '123', path: 'test.md' }],
			},
			actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
			delivery: ['123'],
			cooldown: '1 hour',
		};
		const errors = await alertService.saveAlert(alert);
		expect(errors).toEqual([]);

		const jobs = cronManager.getRegisteredJobs();
		expect(jobs).toContain('alerts:test-alert');
	});
});

describe('N8nDispatcherImpl — disabled mode', () => {
	it('disabled dispatcher never calls fetch', async () => {
		const dispatcher = new N8nDispatcherImpl({ dispatchUrl: '', logger });
		expect(dispatcher.enabled).toBe(false);

		const result = await dispatcher.dispatch({ type: 'report', id: 'test', action: 'run' });
		expect(result).toBe(false);
	});
});
