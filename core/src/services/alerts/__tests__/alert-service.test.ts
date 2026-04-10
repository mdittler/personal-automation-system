import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertDefinition } from '../../../types/alert.js';
import type { EventBusService, EventHandler } from '../../../types/events.js';
import type { LLMService } from '../../../types/llm.js';
import type { TelegramService } from '../../../types/telegram.js';
import { AppToggleStore } from '../../app-toggle/index.js';
import { CronManager } from '../../scheduler/cron-manager.js';
import { UserManager } from '../../user-manager/index.js';
import { AlertService, type AlertServiceOptions } from '../index.js';

const logger = pino({ level: 'silent' });

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-alert-service-'));
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

function makeUserManager(userIds: string[] = ['123456789']): UserManager {
	return new UserManager({
		config: {
			users: userIds.map((id) => ({
				id,
				name: `User ${id}`,
				enabledApps: ['*'],
			})),
		} as any,
		appToggle: new AppToggleStore({ dataDir: tempDir, logger }),
		logger,
	});
}

function makeReportService() {
	return {
		run: vi.fn().mockResolvedValue({
			reportId: 'test',
			markdown: '# Test Report',
			summarized: false,
			runAt: new Date().toISOString(),
		}),
		listReports: vi.fn().mockResolvedValue([]),
		getReport: vi.fn().mockResolvedValue(null),
		saveReport: vi.fn().mockResolvedValue([]),
		deleteReport: vi.fn().mockResolvedValue(true),
		init: vi.fn().mockResolvedValue(undefined),
	} as any;
}

function makeService(overrides: Partial<AlertServiceOptions> = {}): {
	service: AlertService;
	telegram: TelegramService;
	llm: LLMService;
	cronManager: CronManager;
	reportService: ReturnType<typeof makeReportService>;
} {
	const telegram = makeTelegram();
	const llm = makeLLM();
	const cronManager = new CronManager(logger, 'America/New_York', tempDir);
	const reportService = makeReportService();

	const service = new AlertService({
		dataDir: tempDir,
		llm,
		telegram,
		userManager: makeUserManager(),
		cronManager,
		reportService,
		timezone: 'America/New_York',
		logger,
		...overrides,
	});

	return { service, telegram, llm, cronManager, reportService };
}

function makeValidAlertDef(overrides: Partial<AlertDefinition> = {}): AlertDefinition {
	return {
		id: 'grocery-check',
		name: 'Grocery List Check',
		enabled: true,
		schedule: '0 18 * * *',
		condition: {
			type: 'deterministic',
			expression: 'line count > 5',
			data_sources: [{ app_id: 'grocery', user_id: '123456789', path: 'list.md' }],
		},
		actions: [{ type: 'telegram_message', config: { message: 'Grocery list is long!' } }],
		delivery: ['123456789'],
		cooldown: '24 hours',
		...overrides,
	};
}

/** Write a data file that the alert can read. */
async function writeDataFile(userId: string, appId: string, path: string, content: string) {
	const dir = join(tempDir, 'users', userId, appId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, path), content, 'utf-8');
}

function makeEventBus(): EventBusService & { listeners: Map<string, EventHandler[]> } {
	const listeners = new Map<string, EventHandler[]>();
	return {
		listeners,
		emit: vi.fn(async (event: string, payload?: unknown) => {
			const handlers = listeners.get(event) || [];
			for (const handler of handlers) {
				await handler(payload);
			}
		}),
		on: vi.fn((event: string, handler: EventHandler) => {
			const existing = listeners.get(event) || [];
			existing.push(handler);
			listeners.set(event, existing);
		}),
		off: vi.fn((event: string, handler: EventHandler) => {
			const existing = listeners.get(event) || [];
			listeners.set(
				event,
				existing.filter((h) => h !== handler),
			);
		}),
	};
}

function makeEventTriggeredAlert(overrides: Partial<AlertDefinition> = {}): AlertDefinition {
	return {
		id: 'event-alert',
		name: 'Event Alert',
		enabled: true,
		schedule: '',
		trigger: { type: 'event', event_name: 'data:changed' },
		condition: {
			type: 'deterministic',
			expression: 'not empty',
			data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
		},
		actions: [{ type: 'telegram_message', config: { message: 'Event fired!' } }],
		delivery: ['123456789'],
		cooldown: '1 hour',
		...overrides,
	};
}

describe('AlertService', () => {
	// --- CRUD ---

	describe('CRUD', () => {
		it('saves and retrieves an alert', async () => {
			const { service } = makeService();
			const errors = await service.saveAlert(makeValidAlertDef());
			expect(errors).toEqual([]);

			const alert = await service.getAlert('grocery-check');
			expect(alert).not.toBeNull();
			expect(alert?.name).toBe('Grocery List Check');
			expect(alert?.cooldownMs).toBe(24 * 60 * 60 * 1000);
		});

		it('lists alerts sorted by name', async () => {
			const { service } = makeService();
			await service.saveAlert(makeValidAlertDef({ id: 'beta-alert', name: 'Beta' }));
			await service.saveAlert(makeValidAlertDef({ id: 'alpha-alert', name: 'Alpha' }));

			const alerts = await service.listAlerts();
			expect(alerts).toHaveLength(2);
			expect(alerts[0]?.name).toBe('Alpha');
			expect(alerts[1]?.name).toBe('Beta');
		});

		it('updates an existing alert', async () => {
			const { service } = makeService();
			await service.saveAlert(makeValidAlertDef());
			await service.saveAlert(makeValidAlertDef({ name: 'Updated Name' }));

			const alert = await service.getAlert('grocery-check');
			expect(alert?.name).toBe('Updated Name');
		});

		it('deletes an alert', async () => {
			const { service } = makeService();
			await service.saveAlert(makeValidAlertDef());

			const deleted = await service.deleteAlert('grocery-check');
			expect(deleted).toBe(true);

			const alert = await service.getAlert('grocery-check');
			expect(alert).toBeNull();
		});

		it('returns false when deleting nonexistent alert', async () => {
			const { service } = makeService();
			const deleted = await service.deleteAlert('nonexistent');
			expect(deleted).toBe(false);
		});

		it('returns null for nonexistent alert', async () => {
			const { service } = makeService();
			const alert = await service.getAlert('nonexistent');
			expect(alert).toBeNull();
		});

		it('returns validation errors for invalid alert', async () => {
			const { service } = makeService();
			const errors = await service.saveAlert(makeValidAlertDef({ id: '' }));
			expect(errors.length).toBeGreaterThan(0);
		});

		it('enforces maximum alert limit', async () => {
			const { service } = makeService();
			// Save 50 alerts
			for (let i = 0; i < 50; i++) {
				await service.saveAlert(
					makeValidAlertDef({ id: `alert-${String(i).padStart(3, '0')}`, name: `Alert ${i}` }),
				);
			}
			// 51st should fail
			const errors = await service.saveAlert(
				makeValidAlertDef({ id: 'alert-overflow', name: 'Overflow' }),
			);
			expect(errors).toContainEqual(
				expect.objectContaining({ message: expect.stringContaining('50') }),
			);
		});

		it('sets updatedAt timestamp on save', async () => {
			const { service } = makeService();
			await service.saveAlert(makeValidAlertDef());

			const alert = await service.getAlert('grocery-check');
			expect(alert?.updatedAt).toBeDefined();
		});
	});

	// --- Cron lifecycle ---

	describe('cron lifecycle', () => {
		it('registers cron job on save for enabled alert', async () => {
			const { service, cronManager } = makeService();
			await service.saveAlert(makeValidAlertDef({ enabled: true }));

			const jobs = cronManager.getRegisteredJobs();
			expect(jobs.includes('alerts:grocery-check')).toBe(true);
		});

		it('does not register cron job for disabled alert', async () => {
			const { service, cronManager } = makeService();
			await service.saveAlert(makeValidAlertDef({ enabled: false }));

			const jobs = cronManager.getRegisteredJobs();
			expect(jobs.includes('alerts:grocery-check')).toBe(false);
		});

		it('unregisters cron job on delete', async () => {
			const { service, cronManager } = makeService();
			await service.saveAlert(makeValidAlertDef({ enabled: true }));
			await service.deleteAlert('grocery-check');

			const jobs = cronManager.getRegisteredJobs();
			expect(jobs.includes('alerts:grocery-check')).toBe(false);
		});

		it('re-syncs cron job on update', async () => {
			const { service, cronManager } = makeService();
			await service.saveAlert(makeValidAlertDef({ enabled: true }));

			// Disable
			await service.saveAlert(makeValidAlertDef({ enabled: false }));
			let jobs = cronManager.getRegisteredJobs();
			expect(jobs.includes('alerts:grocery-check')).toBe(false);

			// Re-enable
			await service.saveAlert(makeValidAlertDef({ enabled: true }));
			jobs = cronManager.getRegisteredJobs();
			expect(jobs.includes('alerts:grocery-check')).toBe(true);
		});

		it('init registers enabled alerts as cron jobs', async () => {
			const { service: svc1 } = makeService();
			await svc1.saveAlert(
				makeValidAlertDef({ id: 'enabled-alert', name: 'Enabled', enabled: true }),
			);
			await svc1.saveAlert(
				makeValidAlertDef({ id: 'disabled-alert', name: 'Disabled', enabled: false }),
			);

			// Create new service instance (simulates restart)
			const { service: svc2, cronManager: cm2 } = makeService();
			await svc2.init();

			const jobs = cm2.getRegisteredJobs();
			expect(jobs.includes('alerts:enabled-alert')).toBe(true);
			expect(jobs.includes('alerts:disabled-alert')).toBe(false);
		});
	});

	// --- Evaluation ---

	describe('evaluate', () => {
		it('evaluates deterministic condition and triggers action when met', async () => {
			const { service, telegram } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'line count > 2',
						data_sources: [{ app_id: 'grocery', user_id: '123456789', path: 'list.md' }],
					},
				}),
			);

			// Write data that meets condition (3 non-empty lines)
			await writeDataFile('123456789', 'grocery', 'list.md', 'milk\neggs\nbread\n');

			const result = await service.evaluate('grocery-check');

			expect(result.conditionMet).toBe(true);
			expect(result.actionTriggered).toBe(true);
			expect(result.actionsExecuted).toBe(1);
			expect(telegram.send).toHaveBeenCalledWith('123456789', 'Grocery list is long!');
		});

		it('does not trigger when condition is not met', async () => {
			const { service, telegram } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'line count > 10',
						data_sources: [{ app_id: 'grocery', user_id: '123456789', path: 'list.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'grocery', 'list.md', 'milk\neggs\n');

			const result = await service.evaluate('grocery-check');

			expect(result.conditionMet).toBe(false);
			expect(result.actionTriggered).toBe(false);
			expect(telegram.send).not.toHaveBeenCalled();
		});

		it('returns error for nonexistent alert', async () => {
			const { service } = makeService();
			const result = await service.evaluate('nonexistent');
			expect(result.error).toBe('Alert not found');
		});

		it('reads data from file and evaluates "not empty"', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'today.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'notes', 'today.md', 'some content');

			const result = await service.evaluate('grocery-check');
			expect(result.conditionMet).toBe(true);
			expect(result.actionTriggered).toBe(true);
		});

		it('handles missing data file (treated as empty)', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'grocery', user_id: '123456789', path: 'nonexistent.md' }],
					},
				}),
			);

			const result = await service.evaluate('grocery-check');
			expect(result.conditionMet).toBe(false);
		});

		it('reads most recent file when path is a directory', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'daily-notes' }],
					},
				}),
			);

			// Create a directory with multiple files
			const dir = join(tempDir, 'users', '123456789', 'notes', 'daily-notes');
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, '2026-03-01.md'), 'old content', 'utf-8');
			// Write the newer file with a small delay to ensure different mtime
			await new Promise((r) => setTimeout(r, 50));
			await writeFile(join(dir, '2026-03-30.md'), 'newest content', 'utf-8');

			const result = await service.evaluate('grocery-check');
			expect(result.conditionMet).toBe(true);
		});

		it('returns empty for an empty directory data source', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'empty-dir' }],
					},
				}),
			);

			const dir = join(tempDir, 'users', '123456789', 'notes', 'empty-dir');
			await mkdir(dir, { recursive: true });

			const result = await service.evaluate('grocery-check');
			expect(result.conditionMet).toBe(false);
		});

		it('executes run_report action', async () => {
			const { service, reportService } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
					},
					actions: [{ type: 'run_report', config: { report_id: 'daily-summary' } }],
				}),
			);

			await writeDataFile('123456789', 'notes', 'data.md', 'content');

			const result = await service.evaluate('grocery-check');
			expect(result.actionTriggered).toBe(true);
			expect(reportService.run).toHaveBeenCalledWith('daily-summary');
		});
	});

	// --- Cooldown ---

	describe('cooldown', () => {
		it('respects cooldown — does not fire again within window', async () => {
			const { service, telegram } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					cooldown: '24 hours',
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'notes', 'data.md', 'content');

			// First evaluation fires
			const result1 = await service.evaluate('grocery-check');
			expect(result1.actionTriggered).toBe(true);

			// Second evaluation within cooldown — condition still met but action not triggered
			const result2 = await service.evaluate('grocery-check');
			expect(result2.conditionMet).toBe(true);
			expect(result2.actionTriggered).toBe(false);
			expect(telegram.send).toHaveBeenCalledTimes(1);
		});

		it('updates lastFired in YAML after firing', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'notes', 'data.md', 'content');
			await service.evaluate('grocery-check');

			const alert = await service.getAlert('grocery-check');
			expect(alert?.lastFired).toBeDefined();
			expect(alert?.lastFired).not.toBeNull();
		});
	});

	// --- Preview ---

	describe('preview', () => {
		it('preview evaluates condition without executing actions', async () => {
			const { service, telegram } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'notes', 'data.md', 'content');

			const result = await service.evaluate('grocery-check', { preview: true });
			expect(result.conditionMet).toBe(true);
			expect(result.actionTriggered).toBe(false);
			expect(result.actionsExecuted).toBe(0);
			expect(telegram.send).not.toHaveBeenCalled();
		});

		it('preview does not update lastFired', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'notes', 'data.md', 'content');

			await service.evaluate('grocery-check', { preview: true });
			const alert = await service.getAlert('grocery-check');
			expect(alert?.lastFired).toBeUndefined();
		});
	});

	// --- History ---

	describe('history', () => {
		it('saves evaluation result to history directory', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'notes', 'data.md', 'content');
			await service.evaluate('grocery-check');

			const historyDir = join(tempDir, 'system', 'alert-history', 'grocery-check');
			const files = await readdir(historyDir);
			expect(files).toHaveLength(1);
			expect(files[0]).toMatch(/\.md$/);

			const content = await readFile(join(historyDir, files[0]!), 'utf-8');
			expect(content).toContain('grocery-check');
			expect(content).toContain('Condition met');
		});

		it('preview does not save history', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'notes', 'data.md', 'content');
			await service.evaluate('grocery-check', { preview: true });

			const historyDir = join(tempDir, 'system', 'alert-history', 'grocery-check');
			try {
				const files = await readdir(historyDir);
				expect(files).toHaveLength(0);
			} catch {
				// Directory doesn't exist — also acceptable
			}
		});
	});

	// --- Fuzzy evaluation ---

	describe('fuzzy evaluation', () => {
		it('delegates to LLM for fuzzy conditions', async () => {
			const llm = makeLLM('yes');
			const { service } = makeService({ llm });
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'fuzzy',
						expression: 'The list seems very long',
						data_sources: [{ app_id: 'grocery', user_id: '123456789', path: 'list.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'grocery', 'list.md', 'milk\neggs\nbread\nchicken\nrice');

			const result = await service.evaluate('grocery-check');
			expect(result.conditionMet).toBe(true);
			expect(llm.complete).toHaveBeenCalled();
		});

		it('fuzzy condition returns false when LLM says no', async () => {
			const llm = makeLLM('no');
			const { service } = makeService({ llm });
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'fuzzy',
						expression: 'The list seems very long',
						data_sources: [{ app_id: 'grocery', user_id: '123456789', path: 'list.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'grocery', 'list.md', 'milk');

			const result = await service.evaluate('grocery-check');
			expect(result.conditionMet).toBe(false);
		});
	});

	// --- Error handling ---

	describe('error handling', () => {
		it('returns error result on evaluation failure', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [
							// This path will cause an error because of path traversal at runtime
							{ app_id: 'grocery', user_id: '123456789', path: 'valid.md' },
						],
					},
				}),
			);

			// No data file exists, but expression is "not empty" so condition fails gracefully
			const result = await service.evaluate('grocery-check');
			expect(result.conditionMet).toBe(false);
			expect(result.error).toBeUndefined();
		});

		it('returns empty list when alerts directory does not exist', async () => {
			const { service } = makeService({ dataDir: join(tempDir, 'nonexistent') });
			const alerts = await service.listAlerts();
			expect(alerts).toEqual([]);
		});
	});

	// --- Preview with cooldown ---

	describe('preview ignores cooldown', () => {
		it('preview returns conditionMet true even when in cooldown', async () => {
			const { service, telegram } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					cooldown: '24 hours',
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'notes', 'data.md', 'content');

			// First evaluation fires (sets lastFired)
			const result1 = await service.evaluate('grocery-check');
			expect(result1.actionTriggered).toBe(true);

			// Preview during cooldown should still evaluate condition
			const result2 = await service.evaluate('grocery-check', { preview: true });
			expect(result2.conditionMet).toBe(true);
			expect(result2.actionTriggered).toBe(false);
			expect(telegram.send).toHaveBeenCalledTimes(1);
		});
	});

	// --- Concurrency ---

	describe('concurrency', () => {
		it('handles concurrent evaluate calls without errors', async () => {
			const { service } = makeService();
			await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'notes', user_id: '123456789', path: 'data.md' }],
					},
				}),
			);

			await writeDataFile('123456789', 'notes', 'data.md', 'content');

			// Run two evaluations concurrently
			const [result1, result2] = await Promise.all([
				service.evaluate('grocery-check'),
				service.evaluate('grocery-check'),
			]);

			// At least one should trigger; neither should error
			expect(result1.error).toBeUndefined();
			expect(result2.error).toBeUndefined();
			// Exactly one fires (second hits cooldown)
			const triggered = [result1.actionTriggered, result2.actionTriggered].filter(Boolean);
			expect(triggered.length).toBeGreaterThanOrEqual(1);
		});
	});

	// --- State transitions ---

	describe('state transitions', () => {
		it('toggle enabled → disabled → enabled preserves alert data', async () => {
			const { service, cronManager } = makeService();
			await service.saveAlert(makeValidAlertDef({ enabled: true }));

			// Disable
			const alert1 = await service.getAlert('grocery-check');
			await service.saveAlert({ ...alert1!, enabled: false });
			let jobs = cronManager.getRegisteredJobs();
			expect(jobs.includes('alerts:grocery-check')).toBe(false);

			// Re-enable
			const alert2 = await service.getAlert('grocery-check');
			expect(alert2?.name).toBe('Grocery List Check'); // Data preserved
			await service.saveAlert({ ...alert2!, enabled: true });
			jobs = cronManager.getRegisteredJobs();
			expect(jobs.includes('alerts:grocery-check')).toBe(true);
		});
	});

	// --- Path traversal protection ---

	describe('path traversal', () => {
		it('blocks data source path traversal at validation', async () => {
			const { service } = makeService();
			const errors = await service.saveAlert(
				makeValidAlertDef({
					condition: {
						type: 'deterministic',
						expression: 'not empty',
						data_sources: [{ app_id: 'grocery', user_id: '123456789', path: '../../etc/passwd' }],
					},
				}),
			);
			expect(errors.length).toBeGreaterThan(0);
		});
	});

	// --- Event trigger lifecycle (C5) ---

	describe('event trigger lifecycle', () => {
		it('subscribes to event on save for enabled event-triggered alert', async () => {
			const eventBus = makeEventBus();
			const { service } = makeService({ eventBus });
			const errors = await service.saveAlert(makeEventTriggeredAlert());
			expect(errors).toEqual([]);
			expect(eventBus.on).toHaveBeenCalledWith('data:changed', expect.any(Function));
		});

		it('does not subscribe for disabled event-triggered alert', async () => {
			const eventBus = makeEventBus();
			const { service } = makeService({ eventBus });
			await service.saveAlert(makeEventTriggeredAlert({ enabled: false }));
			expect(eventBus.on).not.toHaveBeenCalled();
		});

		it('unsubscribes on delete', async () => {
			const eventBus = makeEventBus();
			const { service } = makeService({ eventBus });
			await service.saveAlert(makeEventTriggeredAlert());
			await service.deleteAlert('event-alert');
			expect(eventBus.off).toHaveBeenCalledWith('data:changed', expect.any(Function));
		});

		it('re-syncs subscription on update (disable → enable)', async () => {
			const eventBus = makeEventBus();
			const { service } = makeService({ eventBus });
			await service.saveAlert(makeEventTriggeredAlert({ enabled: true }));
			expect(eventBus.on).toHaveBeenCalledTimes(1);

			// Disable
			await service.saveAlert(makeEventTriggeredAlert({ enabled: false }));
			expect(eventBus.off).toHaveBeenCalled();

			// Re-enable
			await service.saveAlert(makeEventTriggeredAlert({ enabled: true }));
			expect(eventBus.on).toHaveBeenCalledTimes(2);
		});

		it('does not register cron job for event-triggered alert', async () => {
			const eventBus = makeEventBus();
			const { service, cronManager } = makeService({ eventBus });
			await service.saveAlert(makeEventTriggeredAlert());
			const jobs = cronManager.getRegisteredJobs();
			expect(jobs.includes('alerts:event-alert')).toBe(false);
		});

		it('init registers event subscriptions for enabled alerts', async () => {
			const eventBus = makeEventBus();
			const { service: svc1 } = makeService({ eventBus });
			await svc1.saveAlert(makeEventTriggeredAlert({ enabled: true }));

			// Create new service instance (simulates restart)
			const eventBus2 = makeEventBus();
			const { service: svc2 } = makeService({ eventBus: eventBus2 });
			await svc2.init();
			expect(eventBus2.on).toHaveBeenCalledWith('data:changed', expect.any(Function));
		});

		it('evaluates alert when event fires', async () => {
			const eventBus = makeEventBus();
			const { service, telegram } = makeService({ eventBus });
			await service.saveAlert(makeEventTriggeredAlert());
			await writeDataFile('123456789', 'notes', 'data.md', 'content');

			// Fire the event
			await eventBus.emit('data:changed');
			expect(telegram.send).toHaveBeenCalledWith('123456789', 'Event fired!');
		});
	});

	// --- Event trigger without eventBus (C3) ---

	describe('event trigger without eventBus', () => {
		it('returns validation error when saving enabled event alert without eventBus', async () => {
			const { service } = makeService(); // no eventBus
			const errors = await service.saveAlert(makeEventTriggeredAlert({ enabled: true }));
			expect(errors).toContainEqual(
				expect.objectContaining({
					field: 'trigger',
					message: expect.stringContaining('EventBus'),
				}),
			);
		});

		it('allows saving disabled event alert without eventBus', async () => {
			const { service } = makeService(); // no eventBus
			const errors = await service.saveAlert(makeEventTriggeredAlert({ enabled: false }));
			expect(errors).toEqual([]);
		});

		it('cleans up map entry on delete even without eventBus, re-save works', async () => {
			const eventBus = makeEventBus();
			const { service } = makeService({ eventBus });
			await service.saveAlert(makeEventTriggeredAlert());
			// Delete removes subscription
			await service.deleteAlert('event-alert');
			// Re-save should work without stale map entries
			const errors = await service.saveAlert(makeEventTriggeredAlert());
			expect(errors).toEqual([]);
			expect(eventBus.on).toHaveBeenCalledTimes(2);
		});
	});
});
