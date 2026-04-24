import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cron from 'node-cron';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertDefinition } from '../../../types/alert.js';
import type { ContextStoreService } from '../../../types/context-store.js';
import type { EventBusService, EventHandler } from '../../../types/events.js';
import type { LLMService } from '../../../types/llm.js';
import type { ReportDefinition } from '../../../types/report.js';
import type { TelegramService } from '../../../types/telegram.js';
import { AlertService } from '../../alerts/index.js';
import { AppToggleStore } from '../../app-toggle/index.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { ReportService } from '../../reports/index.js';
import { CronManager } from '../../scheduler/cron-manager.js';
import { UserManager } from '../../user-manager/index.js';
import { registerDailyDiffCron } from '../../../bootstrap/register-daily-diff-cron.js';
import { type N8nDispatcher, N8nDispatcherImpl } from '../index.js';

const logger = pino({ level: 'silent' });
let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-n8n-integration-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
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

function makeEventBus(): EventBusService & { listeners: Map<string, EventHandler[]> } {
	const listeners = new Map<string, EventHandler[]>();
	return {
		listeners,
		emit: vi.fn(async (event: string, payload?: unknown) => {
			const handlers = listeners.get(event) ?? [];
			for (const handler of handlers) {
				await handler(payload);
			}
		}),
		on: vi.fn((event: string, handler: EventHandler) => {
			const existing = listeners.get(event) ?? [];
			existing.push(handler);
			listeners.set(event, existing);
		}),
		off: vi.fn((event: string, handler: EventHandler) => {
			const existing = listeners.get(event) ?? [];
			listeners.set(
				event,
				existing.filter((candidate) => candidate !== handler),
			);
		}),
	};
}

function makeReportDefinition(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
	return {
		id: 'test',
		name: 'Test',
		enabled: true,
		schedule: '0 9 * * 1',
		delivery: ['123'],
		sections: [{ type: 'custom', label: 'Intro', config: { text: 'Hello' } }],
		llm: { enabled: false },
		...overrides,
	};
}

function makeAlertDefinition(overrides: Partial<AlertDefinition> = {}): AlertDefinition {
	return {
		id: 'test-alert',
		name: 'Test Alert',
		enabled: true,
		schedule: '0 * * * *',
		condition: {
			type: 'deterministic',
			expression: 'not empty',
			data_sources: [{ app_id: 'notes', user_id: '123', path: 'test.md' }],
		},
		actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
		delivery: ['123'],
		cooldown: '1 hour',
		...overrides,
	};
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

		await service.saveReport(makeReportDefinition());

		// Cron job should be registered
		const jobs = cronManager.getRegisteredJobs();
		expect(jobs).toContain('reports:test');
	});

	it('dispatches cron-triggered report runs to n8n and skips local execution on success', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
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

		await service.saveReport(makeReportDefinition());
		const runSpy = vi.spyOn(service, 'run').mockResolvedValue(null);

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		await cronCallback();

		expect(dispatcher.dispatch).toHaveBeenCalledWith({
			type: 'report',
			id: 'test',
			action: 'run',
		});
		expect(runSpy).not.toHaveBeenCalled();
	});

	it('falls back to local report execution when n8n dispatch fails', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const dispatcher: N8nDispatcher = {
			enabled: true,
			dispatch: vi.fn().mockResolvedValue(false),
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

		await service.saveReport(makeReportDefinition());
		const runSpy = vi.spyOn(service, 'run').mockResolvedValue(null);

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		await cronCallback();

		expect(dispatcher.dispatch).toHaveBeenCalledWith({
			type: 'report',
			id: 'test',
			action: 'run',
		});
		expect(runSpy).toHaveBeenCalledWith('test');
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

		const errors = await alertService.saveAlert(makeAlertDefinition());
		expect(errors).toEqual([]);

		const jobs = cronManager.getRegisteredJobs();
		expect(jobs).toContain('alerts:test-alert');
	});

	it('dispatches scheduled alert callbacks to n8n and skips internal evaluation on success', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
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

		const errors = await alertService.saveAlert(makeAlertDefinition());
		expect(errors).toEqual([]);

		const evaluateSpy = vi.spyOn(alertService, 'evaluate').mockResolvedValue({
			alertId: 'test-alert',
			conditionMet: false,
			actionTriggered: false,
			actionsExecuted: 0,
		});

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		await cronCallback();

		expect(dispatcher.dispatch).toHaveBeenCalledWith({
			type: 'alert',
			id: 'test-alert',
			action: 'evaluate',
		});
		expect(evaluateSpy).not.toHaveBeenCalled();
	});

	it('falls back to internal evaluation when scheduled alert dispatch fails', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const dispatcher: N8nDispatcher = {
			enabled: true,
			dispatch: vi.fn().mockResolvedValue(false),
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

		const errors = await alertService.saveAlert(makeAlertDefinition());
		expect(errors).toEqual([]);

		const evaluateSpy = vi.spyOn(alertService, 'evaluate').mockResolvedValue({
			alertId: 'test-alert',
			conditionMet: false,
			actionTriggered: false,
			actionsExecuted: 0,
		});

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		await cronCallback();

		expect(dispatcher.dispatch).toHaveBeenCalledWith({
			type: 'alert',
			id: 'test-alert',
			action: 'evaluate',
		});
		expect(evaluateSpy).toHaveBeenCalledWith('test-alert');
	});

	it('dispatches event-triggered alert callbacks to n8n and skips internal evaluation on success', async () => {
		const eventBus = makeEventBus();
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
			eventBus,
			n8nDispatcher: dispatcher,
		});

		const errors = await alertService.saveAlert(
			makeAlertDefinition({
				trigger: { type: 'event', event_name: 'data:changed' },
				schedule: '',
			}),
		);
		expect(errors).toEqual([]);

		const evaluateSpy = vi.spyOn(alertService, 'evaluate').mockResolvedValue({
			alertId: 'test-alert',
			conditionMet: false,
			actionTriggered: false,
			actionsExecuted: 0,
		});

		await eventBus.emit('data:changed');

		expect(dispatcher.dispatch).toHaveBeenCalledWith({
			type: 'alert',
			id: 'test-alert',
			action: 'evaluate',
		});
		expect(evaluateSpy).not.toHaveBeenCalled();
	});

	it('falls back to internal evaluation when event-triggered alert dispatch fails', async () => {
		const eventBus = makeEventBus();
		const dispatcher: N8nDispatcher = {
			enabled: true,
			dispatch: vi.fn().mockResolvedValue(false),
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
			eventBus,
			n8nDispatcher: dispatcher,
		});

		const errors = await alertService.saveAlert(
			makeAlertDefinition({
				trigger: { type: 'event', event_name: 'data:changed' },
				schedule: '',
			}),
		);
		expect(errors).toEqual([]);

		const evaluateSpy = vi.spyOn(alertService, 'evaluate').mockResolvedValue({
			alertId: 'test-alert',
			conditionMet: false,
			actionTriggered: false,
			actionsExecuted: 0,
		});

		await eventBus.emit('data:changed');

		expect(dispatcher.dispatch).toHaveBeenCalledWith({
			type: 'alert',
			id: 'test-alert',
			action: 'evaluate',
		});
		expect(evaluateSpy).toHaveBeenCalledWith('test-alert');
	});
});

describe('n8n dispatch integration — daily diff bootstrap', () => {
	it('dispatches scheduled daily-diff callbacks to n8n and skips internal execution on success', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const dispatcher: N8nDispatcher = {
			enabled: true,
			dispatch: vi.fn().mockResolvedValue(true),
		};
		const cronManager = new CronManager(logger, 'UTC', tempDir);
		const dailyDiff = {
			run: vi.fn().mockResolvedValue(undefined),
		};

		registerDailyDiffCron({
			cronManager,
			dailyDiff,
			n8nDispatcher: dispatcher,
			logger,
		});

		expect(cronManager.getRegisteredJobs()).toContain('system:daily-diff');

		const cronCallback = createTaskSpy.mock.calls.at(-1)?.[1] as (() => Promise<void>) | undefined;
		expect(cronCallback).toBeDefined();

		await cronCallback?.();

		expect(dispatcher.dispatch).toHaveBeenCalledWith({
			type: 'daily_diff',
			id: 'daily-diff',
			action: 'run',
		});
		expect(dailyDiff.run).not.toHaveBeenCalled();
	});

	it('falls back to internal daily-diff execution when n8n dispatch fails', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const dispatcher: N8nDispatcher = {
			enabled: true,
			dispatch: vi.fn().mockResolvedValue(false),
		};
		const cronManager = new CronManager(logger, 'UTC', tempDir);
		const dailyDiff = {
			run: vi.fn().mockResolvedValue(undefined),
		};

		registerDailyDiffCron({
			cronManager,
			dailyDiff,
			n8nDispatcher: dispatcher,
			logger,
		});

		const cronCallback = createTaskSpy.mock.calls.at(-1)?.[1] as (() => Promise<void>) | undefined;
		expect(cronCallback).toBeDefined();

		await cronCallback?.();

		expect(dispatcher.dispatch).toHaveBeenCalledWith({
			type: 'daily_diff',
			id: 'daily-diff',
			action: 'run',
		});
		expect(dailyDiff.run).toHaveBeenCalledOnce();
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
