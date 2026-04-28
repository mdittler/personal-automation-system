#!/usr/bin/env tsx
/**
 * chat-index-prune.ts
 *
 * Prunes expired session transcript files and removes them from the FTS index.
 * Only ended sessions (ended_at IS NOT NULL) older than --retention-days are pruned.
 * Active sessions are never pruned.
 *
 * Usage:
 *   pnpm chat-index-prune [--dry-run] [--retention-days=N] [--db=path] [--data=path]
 *
 * Core logic lives in core/src/services/chat-transcript-index/prune.ts.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ChatTranscriptIndexImpl } from '../core/src/services/chat-transcript-index/chat-transcript-index.js';
import { pruneExpiredSessions } from '../core/src/services/chat-transcript-index/prune.js';

export { pruneExpiredSessions } from '../core/src/services/chat-transcript-index/prune.js';

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			'dry-run': { type: 'boolean', default: false },
			'retention-days': { type: 'string', default: '90' },
			db: { type: 'string', default: 'data/system/chat-state.db' },
			data: { type: 'string', default: 'data/' },
		},
	});

	const dbPath = resolve(process.cwd(), values.db ?? 'data/system/chat-state.db');
	const dataDir = resolve(process.cwd(), values.data ?? 'data/');
	const dryRun = values['dry-run'] ?? false;
	const retentionDaysRaw = Number.parseInt(values['retention-days'] ?? '90', 10);

	if (Number.isNaN(retentionDaysRaw) || retentionDaysRaw < 1 || retentionDaysRaw > 3650) {
		console.error(
			`Error: --retention-days must be an integer between 1 and 3650 (got: ${values['retention-days']})`,
		);
		process.exit(1);
	}

	if (dryRun) {
		console.log('[dry-run] No writes will be performed.');
	}
	console.log(`DB:             ${dbPath}`);
	console.log(`Data:           ${dataDir}`);
	console.log(`Retention days: ${retentionDaysRaw}`);

	if (!dryRun) {
		await mkdir(dirname(dbPath), { recursive: true });
	}

	const index = new ChatTranscriptIndexImpl(dbPath);

	const consoleLogger = {
		info: (obj: unknown, msg?: string) => {
			const prefix = msg ? `[info] ${msg}` : '[info]';
			console.log(prefix, typeof obj === 'object' ? JSON.stringify(obj) : obj);
		},
		warn: (obj: unknown, msg?: string) => {
			const prefix = msg ? `[warn] ${msg}` : '[warn]';
			console.warn(prefix, typeof obj === 'object' ? JSON.stringify(obj) : obj);
		},
	};

	try {
		const result = await pruneExpiredSessions(index, {
			retentionDays: retentionDaysRaw,
			dataDir,
			dryRun,
			logger: consoleLogger,
		});

		console.log(
			`\nDone: ${result.pruned} pruned, ${result.skipped} skipped (dry-run), ${result.errors} errors`,
		);
	} finally {
		await index.close();
	}
}

// Run when invoked as a script (not when imported in tests)
const isMain =
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith('chat-index-prune.ts') ||
	process.argv[1]?.endsWith('chat-index-prune.js');

if (isMain) {
	main().catch((err) => {
		console.error('chat-index-prune failed:', err);
		process.exit(1);
	});
}
