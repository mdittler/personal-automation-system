/**
 * Backups status page (Batch 6, Task 6.2).
 *
 * Admin-only. The GUI never receives a live BackupService instance —
 * bootstrap builds one after GUI registration for the cron path only
 * (RuntimeServices.backupService is always undefined). This route
 * constructs its OWN BackupService from `backupConfig` + `dataDir`/
 * `configDir` when enabled; the constructor is cheap and stateless, so
 * there is no cost to building a fresh one per request.
 *
 * createBackup() THROWS on tar/empty-archive failure and returns '' only
 * on Windows — both paths are wrapped and rendered as a styled error via
 * sendErrorFragment, never a 500.
 */
import { readdir, stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { requirePlatformAdmin } from '../../gui/guards/require-platform-admin.js';
import { BackupService } from '../../services/backup/index.js';
import { sendErrorFragment } from '../utils/error-fragment.js';

export interface BackupsRoutesOptions {
	backupConfig: { enabled: boolean; path: string; schedule: string; retentionCount: number };
	/** Absolute path to the data directory (tarred alongside configDir). */
	dataDir: string;
	/** Absolute path to the config directory (tarred alongside dataDir). */
	configDir: string;
	logger: Logger;
	/** Test seam — see BackupService's own _execFileAsync override. */
	_execFileAsync?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

interface ArchiveInfo {
	name: string;
	sizeBytes: number;
	mtime: string;
}

function buildBackupService(options: BackupsRoutesOptions): BackupService {
	return new BackupService({
		dataDir: options.dataDir,
		configDir: options.configDir,
		backupPath: options.backupConfig.path,
		retentionCount: options.backupConfig.retentionCount,
		logger: options.logger,
		_execFileAsync: options._execFileAsync,
	});
}

async function listArchives(backupPath: string): Promise<ArchiveInfo[]> {
	let entries: string[];
	try {
		entries = await readdir(backupPath);
	} catch {
		return [];
	}

	const archives: ArchiveInfo[] = [];
	for (const name of entries) {
		if (!name.startsWith('pas-backup-') || !name.endsWith('.tar.gz')) continue;
		try {
			const stats = await stat(`${backupPath}/${name}`);
			archives.push({ name, sizeBytes: stats.size, mtime: stats.mtime.toISOString() });
		} catch {
			// Skip archives that vanished between readdir and stat.
		}
	}

	// Newest first — the ISO-timestamped filename sorts chronologically, and
	// mtime is the authoritative freshness signal.
	archives.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
	return archives;
}

export function registerBackupsRoutes(
	server: FastifyInstance,
	options: BackupsRoutesOptions,
): void {
	const { backupConfig } = options;

	server.get(
		'/backups',
		{ preHandler: requirePlatformAdmin },
		async (_request: FastifyRequest, reply: FastifyReply) => {
			if (!backupConfig.enabled) {
				return reply.viewAsync('backups', {
					title: 'Backups — PAS',
					activePage: 'backups',
					enabled: false,
					schedule: backupConfig.schedule,
					path: backupConfig.path,
					retentionCount: backupConfig.retentionCount,
				});
			}

			const archives = await listArchives(backupConfig.path);
			const newest = archives[0];

			return reply.viewAsync('backups', {
				title: 'Backups — PAS',
				activePage: 'backups',
				enabled: true,
				schedule: backupConfig.schedule,
				path: backupConfig.path,
				retentionCount: backupConfig.retentionCount,
				archives,
				newestBackupAt: newest?.mtime ?? null,
			});
		},
	);

	server.post(
		'/backups/run',
		{ preHandler: requirePlatformAdmin },
		async (_request: FastifyRequest, reply: FastifyReply) => {
			if (!backupConfig.enabled) {
				return sendErrorFragment(
					reply,
					400,
					"Backups aren't turned on. Enable them in pas.yaml first.",
				);
			}

			const service = buildBackupService(options);
			let archivePath: string;
			try {
				archivePath = await service.createBackup();
			} catch (err) {
				options.logger.error({ err }, 'Manual backup failed');
				return sendErrorFragment(
					reply,
					400,
					"Couldn't create the backup. Check the server logs for details.",
				);
			}

			if (!archivePath) {
				// Windows: createBackup() returns '' rather than throwing.
				return sendErrorFragment(reply, 400, 'Backups are not supported on this server.');
			}

			const archiveName = archivePath.split(/[/\\]/).pop() ?? archivePath;
			return reply
				.type('text/html')
				.send(
					`<div class="pas-invite-card" role="status"><p>Backup saved: <strong>${archiveName}</strong></p></div>`,
				);
		},
	);
}
