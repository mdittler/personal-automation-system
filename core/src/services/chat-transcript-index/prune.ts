/**
 * prune.ts
 *
 * Prunes expired session transcript files and removes them from the FTS index.
 * Only ended sessions (ended_at IS NOT NULL) older than retentionDays are pruned.
 * Active sessions are never pruned — listExpiredSessions already filters them out.
 *
 * Walks both path layouts:
 *   Legacy:    <dataDir>/users/<userId>/chatbot/conversation/sessions/<id>.md
 *   Household: <dataDir>/households/<householdId>/users/<userId>/chatbot/conversation/sessions/<id>.md
 *
 * After deleting transcript files, sweeps active-sessions.yaml for each affected
 * user to remove any dangling entries (should be rare, but guards against inconsistency).
 */

import { access, unlink, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseYaml, toYaml } from '../../utils/yaml.js';
import { withFileLock } from '../../utils/file-mutex.js';
import type { ChatTranscriptIndex } from './chat-transcript-index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PruneOptions {
	retentionDays: number;
	dataDir: string;
	dryRun?: boolean;
	logger?: {
		info(obj: unknown, msg?: string): void;
		warn(obj: unknown, msg?: string): void;
	};
}

export interface PruneResult {
	pruned: number;
	skipped: number;
	errors: number;
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Returns candidate absolute paths for a session transcript file.
 *
 * NOTE: This function only returns the legacy path
 * (<dataDir>/users/<userId>/chatbot/conversation/sessions/<id>.md).
 * It does NOT return the household path because the householdId is not
 * available in the sessions DB row at this call site. Household paths are
 * handled separately by `findHouseholdPath`, which scans the households
 * directory at runtime.
 */
function candidatePaths(
	dataDir: string,
	userId: string,
	sessionId: string,
): string[] {
	// We don't know the householdId from the sessions row alone, so we must
	// scan.  The DB row only has user_id; household_id may be null.
	// We'll use fs.access to find which path actually exists.
	const legacyPath = join(
		dataDir,
		'users',
		userId,
		'chatbot',
		'conversation',
		'sessions',
		`${sessionId}.md`,
	);
	return [legacyPath];
}

/**
 * Finds the household path by scanning dataDir/households/[id]/users/userId/chatbot.
 * This is needed because the sessions DB row doesn't always have household_id.
 */
async function findHouseholdPath(
	dataDir: string,
	userId: string,
	sessionId: string,
): Promise<string | undefined> {
	const householdsDir = join(dataDir, 'households');
	let householdIds: string[];
	try {
		householdIds = await readdir(householdsDir);
	} catch {
		return undefined;
	}

	for (const hhId of householdIds) {
		const candidate = join(
			householdsDir,
			hhId,
			'users',
			userId,
			'chatbot',
			'conversation',
			'sessions',
			`${sessionId}.md`,
		);
		try {
			await access(candidate);
			return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

/**
 * Resolves the absolute path to the transcript file for the given session.
 * Returns undefined if the file is not found in either layout.
 */
async function resolveTranscriptPath(
	dataDir: string,
	userId: string,
	sessionId: string,
): Promise<string | undefined> {
	// Try legacy path first
	const [legacyPath] = candidatePaths(dataDir, userId, sessionId);
	try {
		await access(legacyPath!);
		return legacyPath!;
	} catch {
		// fall through
	}

	// Try household paths
	return findHouseholdPath(dataDir, userId, sessionId);
}

// ---------------------------------------------------------------------------
// active-sessions.yaml cleanup helper
// ---------------------------------------------------------------------------

/**
 * Returns the path to a user's active-sessions.yaml under the given layout root.
 * rootDir should be either:
 *   <dataDir>/users/<userId>/chatbot
 *   <dataDir>/households/<hhId>/users/<userId>/chatbot
 */
function activeSessionsPath(rootDir: string): string {
	return join(rootDir, 'conversation', 'active-sessions.yaml');
}

/**
 * Remove entries whose id appears in `prunedIds` from one active-sessions.yaml file.
 * Runs under a withFileLock to be safe with concurrent readers.
 */
async function sweepActiveSessionsFile(
	filePath: string,
	lockKey: string,
	prunedIds: Set<string>,
): Promise<void> {
	await withFileLock(lockKey, async () => {
		let raw: string;
		try {
			raw = await readFile(filePath, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw err;
		}

		if (!raw) return;

		let map: Record<string, unknown>;
		try {
			const parsed = parseYaml(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				map = {};
			} else {
				map = parsed as Record<string, unknown>;
			}
		} catch {
			return; // corrupt yaml — leave as-is
		}

		let changed = false;
		for (const key of Object.keys(map)) {
			const entry = map[key];
			if (
				entry &&
				typeof entry === 'object' &&
				!Array.isArray(entry) &&
				typeof (entry as Record<string, unknown>)['id'] === 'string' &&
				prunedIds.has((entry as Record<string, unknown>)['id'] as string)
			) {
				delete map[key];
				changed = true;
			}
		}

		if (changed) {
			await writeFile(filePath, toYaml(map), 'utf8');
		}
	});
}

// ---------------------------------------------------------------------------
// Main prune function
// ---------------------------------------------------------------------------

/**
 * Prune expired sessions from the index and delete their transcript files.
 *
 * @param index  The ChatTranscriptIndex instance to query and update.
 * @param opts   Prune configuration.
 */
export async function pruneExpiredSessions(
	index: ChatTranscriptIndex,
	opts: PruneOptions,
): Promise<PruneResult> {
	const { retentionDays, dataDir, dryRun = false, logger } = opts;

	// 1. Compute cutoff ISO timestamp
	const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const cutoffIso = new Date(cutoffMs).toISOString();

	// 2. List expired sessions from the DB (ended_at IS NOT NULL AND ended_at < cutoffIso)
	const expired = await index.listExpiredSessions(cutoffIso);

	let pruned = 0;
	let skipped = 0;
	let errors = 0;

	// Track which session IDs were successfully pruned (for active-sessions sweep)
	const prunedIds = new Set<string>();

	// Track affected users for the active-sessions sweep
	// Map: userId -> set of base roots (could be legacy or household)
	const affectedUsers = new Set<string>();

	// 3. For each expired session: delete the transcript file and remove from DB
	for (const { id: sessionId, user_id: userId } of expired) {
		try {
			// Find the transcript file path
			const filePath = await resolveTranscriptPath(dataDir, userId, sessionId);

			if (!filePath) {
				// File already gone (e.g. manual deletion) — still remove from DB
				logger?.info(
					{ sessionId, userId },
					'prune: transcript file not found — removing from index only',
				);
				if (!dryRun) {
					await index.deleteSession(sessionId);
				}
				prunedIds.add(sessionId);
				affectedUsers.add(userId);
				pruned++;
				continue;
			}

			if (dryRun) {
				logger?.info(
					{ sessionId, userId, filePath },
					'prune: [dry-run] would delete transcript',
				);
				skipped++;
				continue;
			}

			// Delete the file under a lock (guards against concurrent readers).
			// Handle ENOENT gracefully — a concurrent pruner or manual deletion may have
			// beaten us here. Still remove the DB row so the index stays consistent.
			await withFileLock(
				`conversation-session-transcript:${userId}:${sessionId}`,
				async () => {
					try {
						await unlink(filePath);
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
						// Already deleted — fall through to DB cleanup below
					}
				},
			);

			// Remove from DB (cascades to messages + FTS rows)
			await index.deleteSession(sessionId);

			prunedIds.add(sessionId);
			affectedUsers.add(userId);
			pruned++;

			logger?.info({ sessionId, userId, filePath }, 'prune: deleted transcript');
		} catch (err) {
			logger?.warn({ err, sessionId, userId }, 'prune: error deleting session — skipping');
			errors++;
		}
	}

	// 4. Sweep active-sessions.yaml for all affected users (once per user, not per session)
	// We need to find all possible active-sessions.yaml files for each userId.
	// Both the legacy and household layouts may have them.
	if (!dryRun && prunedIds.size > 0) {
		for (const userId of affectedUsers) {
			// Legacy path
			const legacyRoot = join(dataDir, 'users', userId, 'chatbot');
			const legacyActiveSessions = activeSessionsPath(legacyRoot);
			await sweepActiveSessionsFile(
				legacyActiveSessions,
				`conversation-session-index:${userId}`,
				prunedIds,
			);

			// Household paths — walk all households for this user
			const householdsDir = join(dataDir, 'households');
			let householdIds: string[];
			try {
				householdIds = await readdir(householdsDir);
			} catch {
				householdIds = [];
			}

			for (const hhId of householdIds) {
				const hhRoot = join(householdsDir, hhId, 'users', userId, 'chatbot');
				const hhActiveSessions = activeSessionsPath(hhRoot);
				await sweepActiveSessionsFile(
					hhActiveSessions,
					`conversation-session-index:${userId}`,
					prunedIds,
				);
			}
		}
	}

	return { pruned, skipped, errors };
}
