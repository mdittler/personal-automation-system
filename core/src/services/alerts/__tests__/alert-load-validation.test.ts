/**
 * Tests for D14 fix: strict load-time validation of alert definitions.
 *
 * Verifies that:
 * - Corrupt YAML (parse errors) is skipped and logged
 * - Structurally invalid YAML is included with _validationErrors attached
 * - getAlert() attaches _validationErrors for invalid definitions
 * - evaluate() refuses to execute an alert with _validationErrors
 * - saveAlert() strips _validationErrors before writing to disk
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
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
import { ReportService } from '../../reports/index.js';
import { ChangeLog } from '../../data-store/change-log.js';
import type { ContextStoreService } from '../../../types/context-store.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-alert-load-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeService(overrides: Partial<AlertServiceOptions> = {}): AlertService {
	const logger = pino({ level: 'silent' });
	const userManager = new UserManager({
		config: {
			users: [{ id: '123', name: 'Alice', enabledApps: ['*'] }],
		} as any,
		appToggle: new AppToggleStore({ dataDir: tempDir, logger }),
		logger,
	});
	const cronManager = new CronManager(logger, 'UTC', tempDir);
	const telegram = { send: vi.fn(), sendPhoto: vi.fn(), sendOptions: vi.fn() } as unknown as TelegramService;
	const llm = { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() } as unknown as LLMService;
	const contextStore = { get: vi.fn(), search: vi.fn() } as unknown as ContextStoreService;
	const reportService = new ReportService({
		dataDir: tempDir,
		changeLog: new ChangeLog(tempDir),
		contextStore,
		llm,
		telegram,
		userManager,
		cronManager,
		timezone: 'UTC',
		logger,
	});

	return new AlertService({
		dataDir: tempDir,
		llm,
		telegram,
		userManager,
		cronManager,
		reportService,
		timezone: 'UTC',
		logger,
		...overrides,
	});
}

function makeValidAlert(overrides: Partial<AlertDefinition> = {}): AlertDefinition {
	return {
		id: 'valid-alert',
		name: 'Valid Alert',
		enabled: true,
		schedule: '0 9 * * 1',
		delivery: ['123'],
		condition: {
			type: 'deterministic',
			expression: 'line count > 0',
			data_sources: [{ app_id: 'notes', user_id: '123', path: 'notes.md' }],
		},
		actions: [{ type: 'telegram_message', config: { message: 'Alert fired!' } }],
		cooldown: '1 hour',
		...overrides,
	} as AlertDefinition;
}

async function writeAlertYaml(alertsDir: string, id: string, content: string): Promise<void> {
	await mkdir(alertsDir, { recursive: true });
	await writeFile(join(alertsDir, `${id}.yaml`), content, 'utf-8');
}

describe('Alert load-time validation (D14)', () => {
	const alertsDir = () => join(tempDir, 'system', 'alerts');

	describe('listAlerts()', () => {
		it('skips files with corrupt YAML', async () => {
			const warnSpy = vi.fn();
			const logger = pino({ level: 'silent' });
			logger.warn = warnSpy;
			const service = makeService({ logger } as any);

			await writeAlertYaml(alertsDir(), 'bad', ': : invalid: yaml: [unclosed');

			const alerts = await service.listAlerts();
			expect(alerts).toHaveLength(0);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({ file: 'bad.yaml' }),
				expect.stringContaining('YAML parse error'),
			);
		});

		it('includes structurally invalid alert with _validationErrors', async () => {
			const warnSpy = vi.fn();
			const logger = pino({ level: 'silent' });
			logger.warn = warnSpy;
			const service = makeService({ logger } as any);

			await writeAlertYaml(
				alertsDir(),
				'invalid-alert',
				'id: invalid-alert\nname: 123\nenabled: true\n',
			);

			const alerts = await service.listAlerts();
			expect(alerts).toHaveLength(1);
			expect(alerts[0]._validationErrors).toBeDefined();
			expect(alerts[0]._validationErrors!.length).toBeGreaterThan(0);
		});

		it('returns valid alerts without _validationErrors', async () => {
			const service = makeService();
			await service.saveAlert(makeValidAlert());
			const alerts = await service.listAlerts();
			expect(alerts).toHaveLength(1);
			expect(alerts[0]._validationErrors).toBeUndefined();
		});
	});

	describe('getAlert()', () => {
		it('returns null for corrupt YAML', async () => {
			const service = makeService();
			await writeAlertYaml(alertsDir(), 'bad', ': : invalid');
			const result = await service.getAlert('bad');
			expect(result).toBeNull();
		});

		it('attaches _validationErrors for invalid definition', async () => {
			const service = makeService();
			await writeAlertYaml(
				alertsDir(),
				'invalid-alert',
				'id: invalid-alert\nname: 123\nenabled: true\n',
			);
			const alert = await service.getAlert('invalid-alert');
			expect(alert).not.toBeNull();
			expect(alert!._validationErrors).toBeDefined();
			expect(alert!._validationErrors!.length).toBeGreaterThan(0);
		});
	});

	describe('evaluate() execution gate', () => {
		it('refuses to evaluate an alert with validation errors', async () => {
			const service = makeService();
			await writeAlertYaml(
				alertsDir(),
				'invalid-alert',
				'id: invalid-alert\nname: 123\nenabled: true\n',
			);

			const result = await service.evaluate('invalid-alert');
			expect(result.conditionMet).toBe(false);
			expect(result.actionTriggered).toBe(false);
			expect(result.error).toBe('Alert has validation errors');
		});
	});

	describe('saveAlert() strips _validationErrors', () => {
		it('does not persist _validationErrors to disk', async () => {
			const service = makeService();
			const alert = makeValidAlert();
			// Inject runtime fields
			(alert as any)._validationErrors = [{ field: 'test', message: 'test error' }];
			alert.cooldownMs = 3600000;

			const errors = await service.saveAlert(alert);
			expect(errors).toHaveLength(0);

			const rawContent = await (await import('node:fs/promises')).readFile(
				join(alertsDir(), 'valid-alert.yaml'),
				'utf-8',
			);
			expect(rawContent).not.toContain('_validationErrors');
			expect(rawContent).not.toContain('cooldownMs');
		});
	});
});
