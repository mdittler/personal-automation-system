/**
 * Logger setup using Pino.
 *
 * - Dev mode: pino-pretty to stdout (human-readable, colorized)
 * - Production: JSON to stdout + file transport to data/system/logs/
 *
 * Child loggers are created per service/app with contextual fields.
 */

import { join } from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';
import { ensureDir } from '../../utils/file.js';

export interface CreateLoggerOptions {
	/** Log level. Default: 'info'. */
	level?: string;
	/** Path to the data directory. Used for file transport in production. */
	dataDir?: string;
	/** Whether to use pretty printing (dev mode). */
	pretty?: boolean;
}

/**
 * Create the root Pino logger instance.
 *
 * In dev mode: pretty-printed to stdout.
 * In production: JSON to stdout, plus a file transport to data/system/logs/.
 */
export async function createLogger(options: CreateLoggerOptions = {}): Promise<Logger> {
	const level = options.level ?? 'info';
	const isDev = options.pretty ?? process.env.NODE_ENV !== 'production';

	if (isDev) {
		// Dev mode: use pino-pretty transport
		return pino({
			level,
			transport: {
				target: 'pino-pretty',
				options: {
					colorize: true,
					translateTime: 'HH:MM:ss.l',
					ignore: 'pid,hostname',
				},
			},
		});
	}

	// Production mode: JSON to stdout + file
	const targets: pino.TransportTargetOptions[] = [
		{
			target: 'pino/file',
			options: { destination: 1 }, // stdout
			level,
		},
	];

	if (options.dataDir) {
		const logDir = join(options.dataDir, 'system', 'logs');
		await ensureDir(logDir);

		const logFile = join(logDir, 'pas.log');
		targets.push({
			target: 'pino/file',
			options: { destination: logFile },
			level,
		});
	}

	return pino({
		level,
		transport: {
			targets,
		},
	});
}

/**
 * Create a child logger for a specific service or app.
 */
export function createChildLogger(
	parent: Logger,
	context: { service?: string; appId?: string },
): Logger {
	return parent.child(context);
}

export type { Logger } from 'pino';
