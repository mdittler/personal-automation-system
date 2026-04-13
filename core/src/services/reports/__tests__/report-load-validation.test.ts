/**
 * Tests for D14 fix: strict load-time validation of report definitions.
 *
 * Verifies that:
 * - Corrupt YAML (parse errors) is skipped and logged — not silently dropped
 * - Structurally invalid YAML (valid parse, bad shape) is included in list
 *   with _validationErrors attached, and logged
 * - getReport() attaches _validationErrors for invalid definitions
 * - run() refuses to execute a report with _validationErrors
 * - saveReport() strips _validationErrors before writing to disk
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextStoreService } from '../../../types/context-store.js';
import type { LLMService } from '../../../types/llm.js';
import type { ReportDefinition } from '../../../types/report.js';
import type { TelegramService } from '../../../types/telegram.js';
import { AppToggleStore } from '../../app-toggle/index.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { CronManager } from '../../scheduler/cron-manager.js';
import { UserManager } from '../../user-manager/index.js';
import { ReportService, type ReportServiceOptions } from '../index.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-report-load-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeService(overrides: Partial<ReportServiceOptions> = {}): ReportService {
	const logger = pino({ level: 'silent' });
	const userManager = new UserManager({
		config: {
			users: [{ id: '123', name: 'Alice', enabledApps: ['*'] }],
		} as any,
		appToggle: new AppToggleStore({ dataDir: tempDir, logger }),
		logger,
	});

	return new ReportService({
		dataDir: tempDir,
		changeLog: new ChangeLog(tempDir),
		contextStore: { get: vi.fn(), search: vi.fn() } as unknown as ContextStoreService,
		llm: { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() } as unknown as LLMService,
		telegram: { send: vi.fn(), sendPhoto: vi.fn(), sendOptions: vi.fn() } as unknown as TelegramService,
		userManager,
		cronManager: new CronManager(logger, 'UTC', tempDir),
		timezone: 'UTC',
		logger,
		...overrides,
	});
}

function makeValidReport(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
	return {
		id: 'valid-report',
		name: 'Valid Report',
		enabled: true,
		schedule: '0 9 * * 1',
		delivery: ['123'],
		sections: [{ type: 'custom', label: 'Intro', config: { text: 'Hello' } }],
		llm: { enabled: false },
		...overrides,
	};
}

async function writeReportYaml(reportsDir: string, id: string, content: string): Promise<void> {
	await mkdir(reportsDir, { recursive: true });
	await writeFile(join(reportsDir, `${id}.yaml`), content, 'utf-8');
}

describe('Report load-time validation (D14)', () => {
	const reportsDir = () => join(tempDir, 'system', 'reports');

	describe('listReports()', () => {
		it('skips files with corrupt YAML (parse error)', async () => {
			const warnSpy = vi.fn();
			const logger = pino({ level: 'silent' });
			logger.warn = warnSpy;
			const service = makeService({ logger } as any);

			await writeReportYaml(reportsDir(), 'bad-yaml', ': : invalid: yaml: [unclosed');

			const reports = await service.listReports();
			expect(reports).toHaveLength(0);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({ file: 'bad-yaml.yaml' }),
				expect.stringContaining('YAML parse error'),
			);
		});

		it('skips files that are not objects', async () => {
			const service = makeService();
			await writeReportYaml(reportsDir(), 'not-object', '42');
			const reports = await service.listReports();
			expect(reports).toHaveLength(0);
		});

		it('skips files with no id field', async () => {
			const service = makeService();
			await writeReportYaml(reportsDir(), 'no-id', 'name: Missing ID\nenabled: true\n');
			const reports = await service.listReports();
			expect(reports).toHaveLength(0);
		});

		it('includes structurally invalid report with _validationErrors attached', async () => {
			const warnSpy = vi.fn();
			const logger = pino({ level: 'silent' });
			logger.warn = warnSpy;
			const service = makeService({ logger } as any);

			// Valid YAML, valid object, valid id — but missing required fields (name, schedule, etc.)
			await writeReportYaml(
				reportsDir(),
				'invalid-report',
				'id: invalid-report\nname: 123\nenabled: true\n',
			);

			const reports = await service.listReports();
			expect(reports).toHaveLength(1);
			expect(reports[0]._validationErrors).toBeDefined();
			expect(reports[0]._validationErrors!.length).toBeGreaterThan(0);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({ reportId: 'invalid-report' }),
				expect.stringContaining('validation errors'),
			);
		});

		it('returns valid reports without _validationErrors', async () => {
			const service = makeService();
			await service.saveReport(makeValidReport());

			const reports = await service.listReports();
			expect(reports).toHaveLength(1);
			expect(reports[0]._validationErrors).toBeUndefined();
		});
	});

	describe('getReport()', () => {
		it('returns null for corrupt YAML', async () => {
			const service = makeService();
			await writeReportYaml(reportsDir(), 'bad', ': : invalid');
			const result = await service.getReport('bad');
			expect(result).toBeNull();
		});

		it('attaches _validationErrors for invalid definition', async () => {
			const service = makeService();
			await writeReportYaml(
				reportsDir(),
				'invalid-report',
				'id: invalid-report\nname: 123\nenabled: true\n',
			);

			const report = await service.getReport('invalid-report');
			expect(report).not.toBeNull();
			expect(report!._validationErrors).toBeDefined();
			expect(report!._validationErrors!.length).toBeGreaterThan(0);
		});

		it('returns valid report without _validationErrors', async () => {
			const service = makeService();
			await service.saveReport(makeValidReport());
			const report = await service.getReport('valid-report');
			expect(report).not.toBeNull();
			expect(report!._validationErrors).toBeUndefined();
		});
	});

	describe('run() execution gate', () => {
		it('refuses to run a report with validation errors', async () => {
			const service = makeService();
			await writeReportYaml(
				reportsDir(),
				'invalid-report',
				'id: invalid-report\nname: 123\nenabled: true\n',
			);

			const result = await service.run('invalid-report');
			expect(result).toBeNull();
		});

		it('runs a valid report normally', async () => {
			const service = makeService();
			await service.saveReport(makeValidReport());

			const result = await service.run('valid-report', { preview: true });
			expect(result).not.toBeNull();
			expect(result!.reportId).toBe('valid-report');
		});
	});

	describe('saveReport() strips _validationErrors', () => {
		it('does not persist _validationErrors to disk', async () => {
			const service = makeService();
			const report = makeValidReport();
			// Inject a runtime _validationErrors field
			(report as any)._validationErrors = [{ field: 'test', message: 'test error' }];

			const errors = await service.saveReport(report);
			expect(errors).toHaveLength(0); // saveReport validates independently

			// Read raw file to confirm _validationErrors is not present
			const rawContent = await (await import('node:fs/promises')).readFile(
				join(reportsDir(), 'valid-report.yaml'),
				'utf-8',
			);
			expect(rawContent).not.toContain('_validationErrors');
		});
	});
});
