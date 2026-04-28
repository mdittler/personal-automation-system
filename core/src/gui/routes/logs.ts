/**
 * Logs route.
 *
 * GET /gui/logs — log viewer with level filtering and htmx auto-refresh.
 * GET /gui/logs/entries — htmx partial returning just the log table rows.
 */

import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { requirePlatformAdmin } from '../../gui/guards/require-platform-admin.js';

export interface LogsOptions {
	dataDir: string;
	logger: Logger;
}

interface LogEntry {
	level: number;
	levelLabel: string;
	time: string;
	msg: string;
	service?: string;
	appId?: string;
}

const LEVEL_LABELS: Record<number, string> = {
	10: 'trace',
	20: 'debug',
	30: 'info',
	40: 'warn',
	50: 'error',
	60: 'fatal',
};

const LEVEL_NUMBERS: Record<string, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
};

/** Maximum bytes to read from the end of the log file. */
const MAX_TAIL_BYTES = 512 * 1024; // 512KB

/**
 * Read log entries from the end of the file.
 * Only reads the last MAX_TAIL_BYTES to bound memory usage
 * regardless of total log file size.
 */
async function readLogEntries(
	logFilePath: string,
	limit: number,
	minLevel?: string,
): Promise<{ entries: LogEntry[]; available: boolean }> {
	let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		const fileStat = await stat(logFilePath);
		fileHandle = await open(logFilePath, 'r');

		const fileSize = fileStat.size;
		const readSize = Math.min(fileSize, MAX_TAIL_BYTES);
		const offset = fileSize - readSize;

		const buffer = Buffer.alloc(readSize);
		await fileHandle.read(buffer, 0, readSize, offset);

		let content = buffer.toString('utf-8');

		// If we didn't read from the start, skip the first partial line
		if (offset > 0) {
			const firstNewline = content.indexOf('\n');
			if (firstNewline !== -1) {
				content = content.slice(firstNewline + 1);
			}
		}

		const lines = content.trim().split('\n').filter(Boolean);
		const minLevelNum = minLevel ? (LEVEL_NUMBERS[minLevel] ?? 0) : 0;

		const entries: LogEntry[] = [];
		// Process from end for reverse chronological order
		for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
			try {
				const line = lines[i];
				if (!line) continue;
				const parsed = JSON.parse(line);
				const level = typeof parsed.level === 'number' ? parsed.level : 30;

				if (level < minLevelNum) continue;

				entries.push({
					level,
					levelLabel: LEVEL_LABELS[level] ?? 'unknown',
					time: parsed.time
						? new Date(parsed.time).toISOString().replace('T', ' ').slice(0, 19)
						: '-',
					msg: parsed.msg ?? '',
					service: parsed.service,
					appId: parsed.appId,
				});
			} catch {
				// Skip unparseable lines
			}
		}

		return { entries, available: true };
	} catch {
		return { entries: [], available: false };
	} finally {
		await fileHandle?.close();
	}
}

export function registerLogsRoutes(server: FastifyInstance, options: LogsOptions): void {
	const { dataDir } = options;
	const logFilePath = join(dataDir, 'system', 'logs', 'pas.log');

	const platformAdminOnly = { preHandler: [requirePlatformAdmin] };

	// Full page
	server.get('/logs', platformAdminOnly, async (request: FastifyRequest, reply: FastifyReply) => {
		const query = request.query as { level?: string };
		const level = query.level || '';
		const { entries, available } = await readLogEntries(logFilePath, 100, level || undefined);

		return reply.viewAsync('logs', {
			title: 'Logs — PAS',
			activePage: 'logs',
			entries,
			available,
			currentLevel: level,
		});
	});

	// htmx partial — just the table body
	server.get(
		'/logs/entries',
		platformAdminOnly,
		async (request: FastifyRequest, reply: FastifyReply) => {
			const query = request.query as { level?: string; limit?: string };
			const level = query.level || '';
			const limit = Math.min(Number(query.limit) || 100, 500);
			const { entries, available } = await readLogEntries(logFilePath, limit, level || undefined);

			if (!available) {
				return reply
					.type('text/html')
					.send('<tr><td colspan="5">Log file not available.</td></tr>');
			}

			const rows = entries
				.map(
					(e) =>
						`<tr class="${e.level >= 40 ? 'status-err' : ''}"><td><small>${escapeHtml(e.time)}</small></td><td><kbd>${escapeHtml(e.levelLabel)}</kbd></td><td>${escapeHtml(e.service || e.appId || '-')}</td><td>${escapeHtml(e.msg)}</td></tr>`,
				)
				.join('\n');

			return reply.type('text/html').send(rows);
		},
	);
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
