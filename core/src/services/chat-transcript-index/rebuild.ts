/**
 * rebuild.ts
 *
 * Core logic for rebuilding the chat transcript FTS index from raw Markdown
 * session files on disk.  Exported for both the CLI script and integration tests.
 *
 * Walks both path layouts:
 *   Legacy:    <dataDir>/users/<userId>/chatbot/conversation/sessions/*.md
 *   Household: <dataDir>/households/<householdId>/users/<userId>/chatbot/conversation/sessions/*.md
 */

import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CorruptTranscriptError } from '../conversation-session/errors.js';
import { decode } from '../conversation-session/transcript-codec.js';
import { ChatTranscriptIndexImpl } from './chat-transcript-index.js';
import type { MessageRow, SessionRow } from './types.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RebuildResult {
	sessions: number;
	turns: number;
	skipped: number;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface SessionFile {
	filePath: string;
	userId: string;
	householdId: string | null;
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

async function isDir(p: string): Promise<boolean> {
	try {
		const s = await stat(p);
		return s.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Walks <dataDir>/users/<userId>/chatbot/conversation/sessions/
 * and yields { filePath, userId, householdId: null } for each *.md file.
 */
async function* walkLegacyPaths(dataDir: string): AsyncGenerator<SessionFile> {
	const usersDir = join(dataDir, 'users');
	if (!(await isDir(usersDir))) return;

	let userIds: string[];
	try {
		userIds = await readdir(usersDir);
	} catch {
		return;
	}

	for (const userId of userIds) {
		if (userId === 'shared') continue;
		const sessionsDir = join(usersDir, userId, 'chatbot', 'conversation', 'sessions');
		if (!(await isDir(sessionsDir))) continue;

		let files: string[];
		try {
			files = await readdir(sessionsDir);
		} catch {
			continue;
		}

		for (const file of files) {
			if (!file.endsWith('.md')) continue;
			yield { filePath: join(sessionsDir, file), userId, householdId: null };
		}
	}
}

/**
 * Walks <dataDir>/households/<householdId>/users/<userId>/chatbot/conversation/sessions/
 * and yields { filePath, userId, householdId } for each *.md file.
 */
async function* walkHouseholdPaths(dataDir: string): AsyncGenerator<SessionFile> {
	const householdsDir = join(dataDir, 'households');
	if (!(await isDir(householdsDir))) return;

	let householdIds: string[];
	try {
		householdIds = await readdir(householdsDir);
	} catch {
		return;
	}

	for (const householdId of householdIds) {
		const usersDir = join(householdsDir, householdId, 'users');
		if (!(await isDir(usersDir))) continue;

		let userIds: string[];
		try {
			userIds = await readdir(usersDir);
		} catch {
			continue;
		}

		for (const userId of userIds) {
			const sessionsDir = join(usersDir, userId, 'chatbot', 'conversation', 'sessions');
			if (!(await isDir(sessionsDir))) continue;

			let files: string[];
			try {
				files = await readdir(sessionsDir);
			} catch {
				continue;
			}

			for (const file of files) {
				if (!file.endsWith('.md')) continue;
				yield { filePath: join(sessionsDir, file), userId, householdId };
			}
		}
	}
}

// ─── Core rebuild function ────────────────────────────────────────────────────

/**
 * Rebuilds the FTS index from raw transcript Markdown files.
 *
 * @param opts.dbPath   Path to the SQLite database file to write.
 * @param opts.dataDir  Root data directory (e.g. `data/`).
 * @param opts.dryRun   When true, log what would be indexed but do not write.
 */
export async function rebuildIndex(opts: {
	dbPath: string;
	dataDir: string;
	dryRun?: boolean;
}): Promise<RebuildResult> {
	const { dbPath, dataDir, dryRun = false } = opts;

	if (!dryRun) {
		await mkdir(dirname(dbPath), { recursive: true });
		// Full rebuild: delete the existing DB so stale sessions (whose .md files
		// were deleted) don't persist. The local-first invariant means SQLite is
		// always rebuildable from the canonical Markdown files.
		try {
			await unlink(dbPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
	}

	const index = dryRun ? null : new ChatTranscriptIndexImpl(dbPath);

	let sessions = 0;
	let turns = 0;
	let skipped = 0;

	async function processFile(sf: SessionFile): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(sf.filePath, 'utf8');
		} catch (err) {
			console.warn(`[warn] Could not read ${sf.filePath}: ${String(err)} — skipping`);
			skipped++;
			return;
		}

		let decoded: ReturnType<typeof decode>;
		try {
			decoded = decode(raw);
		} catch (err) {
			if (err instanceof CorruptTranscriptError) {
				console.warn(`[warn] Corrupt transcript ${sf.filePath}: ${err.message} — skipping`);
				skipped++;
				return;
			}
			throw err;
		}

		const { meta, turns: sessionTurns } = decoded;
		// Path-derived identity is authoritative. Frontmatter fields are informational
		// only; a mismatch indicates a file moved or was tampered with.
		const sessionId = basename(sf.filePath, '.md');
		if (meta.id && meta.id !== sessionId) {
			console.warn(
				`[warn] Frontmatter id "${meta.id}" disagrees with filename "${sessionId}" in ${sf.filePath} — skipping`,
			);
			skipped++;
			return;
		}
		if (meta.user_id && meta.user_id !== sf.userId) {
			console.warn(
				`[warn] Frontmatter user_id "${meta.user_id}" disagrees with path userId "${sf.userId}" in ${sf.filePath} — skipping`,
			);
			skipped++;
			return;
		}
		if (meta.household_id && sf.householdId && meta.household_id !== sf.householdId) {
			console.warn(
				`[warn] Frontmatter household_id "${meta.household_id}" disagrees with path householdId "${sf.householdId}" in ${sf.filePath} — skipping`,
			);
			skipped++;
			return;
		}

		if (dryRun) {
			console.log(
				`[dry-run] session ${sessionId}  user=${sf.userId}  household=${sf.householdId ?? '(none)'}  turns=${sessionTurns.length}`,
			);
			sessions++;
			turns += sessionTurns.length;
			return;
		}

		const sessionRow: SessionRow = {
			id: sessionId,
			user_id: sf.userId,
			household_id: sf.householdId,
			source: meta.source ?? 'telegram',
			started_at: meta.started_at,
			ended_at: meta.ended_at ?? null,
			model: meta.model ?? null,
			title: meta.title ?? null,
		};

		await index!.upsertSession(sessionRow);

		for (let i = 0; i < sessionTurns.length; i++) {
			const turn = sessionTurns[i]!;
			const messageRow: MessageRow = {
				session_id: sessionId,
				turn_index: i,
				role: turn.role,
				content: turn.content,
				timestamp: turn.timestamp,
			};
			await index!.appendMessage(messageRow);
		}

		sessions++;
		turns += sessionTurns.length;
	}

	try {
		for await (const sf of walkLegacyPaths(dataDir)) {
			await processFile(sf);
		}

		for await (const sf of walkHouseholdPaths(dataDir)) {
			await processFile(sf);
		}
	} finally {
		if (index) {
			await index.close();
		}
	}

	return { sessions, turns, skipped };
}
