import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupService } from '../index.js';

// Minimal pino-like logger stub
const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as import('pino').Logger;

let tempDir: string;
let dataDir: string;
let configDir: string;
let backupPath: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-backup-test-'));
	dataDir = join(tempDir, 'data');
	configDir = join(tempDir, 'config');
	backupPath = join(tempDir, 'backups');
	vi.clearAllMocks();
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Cross-platform tests (run on all platforms including Windows)
// ---------------------------------------------------------------------------

describe('BackupService — cross-platform', () => {
	it('cleanupOldBackups keeps only N newest files', async () => {
		const { mkdir, writeFile: wf } = await import('node:fs/promises');
		await mkdir(backupPath, { recursive: true });

		// Write 5 fake backup archives (names are chronologically sortable)
		const names = [
			'pas-backup-2026-01-01T00-00-00.tar.gz',
			'pas-backup-2026-01-02T00-00-00.tar.gz',
			'pas-backup-2026-01-03T00-00-00.tar.gz',
			'pas-backup-2026-01-04T00-00-00.tar.gz',
			'pas-backup-2026-01-05T00-00-00.tar.gz',
		];
		for (const name of names) {
			await wf(join(backupPath, name), 'fake', 'utf-8');
		}

		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 3,
			logger,
		});

		await service.cleanupOldBackups();

		const { readdir } = await import('node:fs/promises');
		const remaining = (await readdir(backupPath)).filter(
			(f) => f.startsWith('pas-backup-') && f.endsWith('.tar.gz'),
		);

		expect(remaining).toHaveLength(3);
		// Newest 3 are kept
		expect(remaining).toContain('pas-backup-2026-01-03T00-00-00.tar.gz');
		expect(remaining).toContain('pas-backup-2026-01-04T00-00-00.tar.gz');
		expect(remaining).toContain('pas-backup-2026-01-05T00-00-00.tar.gz');
		// Oldest 2 are deleted
		expect(remaining).not.toContain('pas-backup-2026-01-01T00-00-00.tar.gz');
		expect(remaining).not.toContain('pas-backup-2026-01-02T00-00-00.tar.gz');
	});

	it('cleanupOldBackups sorts files chronologically by name', async () => {
		const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
		await md(backupPath, { recursive: true });

		// Write files out of order to confirm sorting works
		const names = [
			'pas-backup-2026-03-01T00-00-00.tar.gz',
			'pas-backup-2026-01-01T00-00-00.tar.gz',
			'pas-backup-2026-02-01T00-00-00.tar.gz',
		];
		for (const name of names) {
			await wf(join(backupPath, name), 'fake', 'utf-8');
		}

		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 2,
			logger,
		});

		await service.cleanupOldBackups();

		const { readdir } = await import('node:fs/promises');
		const remaining = (await readdir(backupPath)).filter(
			(f) => f.startsWith('pas-backup-') && f.endsWith('.tar.gz'),
		);

		// Jan should be deleted (oldest), Feb and Mar kept (newest 2)
		expect(remaining).not.toContain('pas-backup-2026-01-01T00-00-00.tar.gz');
		expect(remaining).toContain('pas-backup-2026-02-01T00-00-00.tar.gz');
		expect(remaining).toContain('pas-backup-2026-03-01T00-00-00.tar.gz');
	});

	it('cleanupOldBackups is a no-op when directory does not exist', async () => {
		const service = new BackupService({
			dataDir,
			configDir,
			backupPath: join(tempDir, 'nonexistent-backups'),
			retentionCount: 3,
			logger,
		});

		// Should not throw
		await expect(service.cleanupOldBackups()).resolves.toBeUndefined();
	});

	it('cleanupOldBackups is a no-op when fewer files than retention count', async () => {
		const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
		await md(backupPath, { recursive: true });

		await wf(join(backupPath, 'pas-backup-2026-01-01T00-00-00.tar.gz'), 'fake', 'utf-8');

		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 7,
			logger,
		});

		await service.cleanupOldBackups();

		const { readdir } = await import('node:fs/promises');
		const remaining = (await readdir(backupPath)).filter(
			(f) => f.startsWith('pas-backup-') && f.endsWith('.tar.gz'),
		);

		// File should still exist
		expect(remaining).toHaveLength(1);
	});

	it('cleanupOldBackups ignores files that do not match naming pattern', async () => {
		const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
		await md(backupPath, { recursive: true });

		await wf(join(backupPath, 'unrelated-file.tar.gz'), 'fake', 'utf-8');
		await wf(join(backupPath, 'pas-backup-2026-01-01T00-00-00.tar.gz'), 'fake', 'utf-8');
		await wf(join(backupPath, 'pas-backup-2026-01-02T00-00-00.tar.gz'), 'fake', 'utf-8');

		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 1,
			logger,
		});

		await service.cleanupOldBackups();

		const { readdir } = await import('node:fs/promises');
		const remaining = await readdir(backupPath);

		// unrelated-file.tar.gz must not be deleted
		expect(remaining).toContain('unrelated-file.tar.gz');
		// Oldest backup deleted, newest kept
		expect(remaining).not.toContain('pas-backup-2026-01-01T00-00-00.tar.gz');
		expect(remaining).toContain('pas-backup-2026-01-02T00-00-00.tar.gz');
	});

	it('createBackup logs warning and returns empty string on Windows', async () => {
		// Mock process.platform to simulate Windows
		const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

		try {
			const service = new BackupService({
				dataDir,
				configDir,
				backupPath,
				retentionCount: 7,
				logger,
			});

			const result = await service.createBackup();

			expect(result).toBe('');
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringMatching(/not supported on Windows/i),
			);
		} finally {
			platformSpy.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// Platform-specific tests — Unix/macOS only (require `tar` command)
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('BackupService — tar', () => {
	beforeEach(async () => {
		const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
		// Set up minimal data and config dirs with a file each
		await md(dataDir, { recursive: true });
		await md(configDir, { recursive: true });
		await wf(join(dataDir, 'test.md'), '# test data', 'utf-8');
		await wf(join(configDir, 'pas.yaml'), 'users: []', 'utf-8');
	});

	it('createBackup creates a valid tarball with data and config dirs', async () => {
		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 7,
			logger,
		});

		const dest = await service.createBackup();

		expect(dest).toBeTruthy();
		expect(dest).toMatch(/pas-backup-.+\.tar\.gz$/);

		const { stat } = await import('node:fs/promises');
		const stats = await stat(dest);
		expect(stats.size).toBeGreaterThan(0);
	});

	it('createBackup verifies tarball contains data and config entries', async () => {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const execFileAsync = promisify(execFile);

		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 7,
			logger,
		});

		const dest = await service.createBackup();

		// List tarball contents to verify both dirs are included
		const { stdout } = await execFileAsync('tar', ['-tf', dest]);
		expect(stdout).toContain('data');
		expect(stdout).toContain('config');
	});

	it('createBackup calls cleanupOldBackups after success', async () => {
		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 7,
			logger,
		});

		const cleanupSpy = vi.spyOn(service, 'cleanupOldBackups');

		await service.createBackup();

		expect(cleanupSpy).toHaveBeenCalledOnce();
	});

	it('createBackup throws if output size is zero', async () => {
		// Inject a fake execFileAsync that writes an empty file instead of running tar.
		// We cannot spy on the real execFile because promisify() captures the reference
		// at module import time — the spy would not be seen by execFileAsync.
		const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
		await md(backupPath, { recursive: true });

		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 7,
			logger,
			_execFileAsync: async (_cmd: string, args: string[]) => {
				// args[1] is the dest path: tar -czf <dest> ...
				const destPath = args[1] as string;
				await wf(destPath, '', 'utf-8');
				return { stdout: '', stderr: '' };
			},
		});

		await expect(service.createBackup()).rejects.toThrow(/empty/i);
	});

	it('createBackup cleans up partial archive when tar fails', async () => {
		// Inject a fake execFileAsync that writes a partial file then throws.
		const { mkdir: md, writeFile: wf, readdir } = await import('node:fs/promises');
		await md(backupPath, { recursive: true });

		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 7,
			logger,
			_execFileAsync: async (_cmd: string, args: string[]) => {
				const destPath = args[1] as string;
				// Simulate tar writing some bytes then failing
				await wf(destPath, 'partial', 'utf-8');
				throw new Error('tar: write error');
			},
		});

		await expect(service.createBackup()).rejects.toThrow(/tar/i);

		// The partial file must have been cleaned up
		const remaining = (await readdir(backupPath)).filter((f) =>
			f.startsWith('pas-backup-'),
		);
		expect(remaining).toHaveLength(0);
	});

	it('createBackup creates backup dir if it does not exist', async () => {
		const newBackupPath = join(tempDir, 'new-backup-dir');

		const service = new BackupService({
			dataDir,
			configDir,
			backupPath: newBackupPath,
			retentionCount: 7,
			logger,
		});

		const dest = await service.createBackup();

		expect(dest).toBeTruthy();
		const { stat } = await import('node:fs/promises');
		const stats = await stat(dest);
		expect(stats.size).toBeGreaterThan(0);
	});

	it('createBackup enforces retention after creating archive', async () => {
		const { writeFile: wf } = await import('node:fs/promises');
		const { mkdir: md } = await import('node:fs/promises');
		await md(backupPath, { recursive: true });

		// Pre-populate 3 old fake archives
		const oldNames = [
			'pas-backup-2020-01-01T00-00-00.tar.gz',
			'pas-backup-2020-01-02T00-00-00.tar.gz',
			'pas-backup-2020-01-03T00-00-00.tar.gz',
		];
		for (const name of oldNames) {
			await wf(join(backupPath, name), 'old fake backup', 'utf-8');
		}

		const service = new BackupService({
			dataDir,
			configDir,
			backupPath,
			retentionCount: 2,
			logger,
		});

		await service.createBackup();

		const { readdir } = await import('node:fs/promises');
		const remaining = (await readdir(backupPath)).filter(
			(f) => f.startsWith('pas-backup-') && f.endsWith('.tar.gz'),
		);

		// retentionCount=2 → keep only 2 (the new real backup + 1 old)
		expect(remaining).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Config loader tests for backup section
// ---------------------------------------------------------------------------

describe('loadSystemConfig — backup defaults', () => {
	it('uses default backup config when backup section is omitted', async () => {
		const { mkdtemp: mkdt, rm: rmf, writeFile: wf } = await import('node:fs/promises');
		const { join: pjoin } = await import('node:path');
		const { tmpdir: td } = await import('node:os');
		const { stringify } = await import('yaml');
		const { loadSystemConfig } = await import('../../config/index.js');

		const dir = await mkdt(pjoin(td(), 'pas-cfg-backup-'));
		try {
			const envPath = pjoin(dir, '.env');
			const yamlPath = pjoin(dir, 'pas.yaml');

			await wf(
				envPath,
				'TELEGRAM_BOT_TOKEN=t\nANTHROPIC_API_KEY=k\nGUI_AUTH_TOKEN=g',
				'utf-8',
			);
			await wf(yamlPath, stringify({ defaults: {} }), 'utf-8');

			const config = await loadSystemConfig({ envPath, configPath: yamlPath });

			expect(config.backup.enabled).toBe(false);
			expect(config.backup.path).toContain('backups');
			expect(config.backup.schedule).toBe('0 3 * * *');
			expect(config.backup.retentionCount).toBe(7);
		} finally {
			await rmf(dir, { recursive: true, force: true });
		}
	});

	it('uses defaults for unspecified backup fields when only enabled is set', async () => {
		const { mkdtemp: mkdt, rm: rmf, writeFile: wf } = await import('node:fs/promises');
		const { join: pjoin } = await import('node:path');
		const { tmpdir: td } = await import('node:os');
		const { stringify } = await import('yaml');
		const { loadSystemConfig } = await import('../../config/index.js');

		const dir = await mkdt(pjoin(td(), 'pas-cfg-backup-partial-'));
		try {
			const envPath = pjoin(dir, '.env');
			const yamlPath = pjoin(dir, 'pas.yaml');

			await wf(
				envPath,
				'TELEGRAM_BOT_TOKEN=t\nANTHROPIC_API_KEY=k\nGUI_AUTH_TOKEN=g',
				'utf-8',
			);
			await wf(yamlPath, stringify({ backup: { enabled: true } }), 'utf-8');

			const config = await loadSystemConfig({ envPath, configPath: yamlPath });

			expect(config.backup.enabled).toBe(true);
			expect(config.backup.path).toContain('backups');
			expect(config.backup.schedule).toBe('0 3 * * *');
			expect(config.backup.retentionCount).toBe(7);
		} finally {
			await rmf(dir, { recursive: true, force: true });
		}
	});

	it('throws Zod validation error when retention_count is 0', async () => {
		const { mkdtemp: mkdt, rm: rmf, writeFile: wf } = await import('node:fs/promises');
		const { join: pjoin } = await import('node:path');
		const { tmpdir: td } = await import('node:os');
		const { stringify } = await import('yaml');
		const { loadSystemConfig } = await import('../../config/index.js');

		const dir = await mkdt(pjoin(td(), 'pas-cfg-backup-invalid-'));
		try {
			const envPath = pjoin(dir, '.env');
			const yamlPath = pjoin(dir, 'pas.yaml');

			await wf(
				envPath,
				'TELEGRAM_BOT_TOKEN=t\nANTHROPIC_API_KEY=k\nGUI_AUTH_TOKEN=g',
				'utf-8',
			);
			await wf(
				yamlPath,
				stringify({ backup: { enabled: true, retention_count: 0 } }),
				'utf-8',
			);

			await expect(loadSystemConfig({ envPath, configPath: yamlPath })).rejects.toThrow(
				/Invalid pas\.yaml|retention_count|Number must be greater than/i,
			);
		} finally {
			await rmf(dir, { recursive: true, force: true });
		}
	});
});
