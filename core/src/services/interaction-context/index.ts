/**
 * InteractionContextService — per-user interaction tracking with optional disk persistence.
 *
 * Records the last N interactions per user with a TTL. Used for contextual
 * follow-ups: e.g., after a receipt photo is captured, "show me those costs"
 * can resolve to the correct data file using recent interaction context.
 *
 * Design decisions:
 * - Optional disk persistence via debounced flush (default: in-memory only).
 * - In-memory mode: when `dataDir` is undefined, no disk I/O is performed.
 * - Circular buffer of 5 entries per user (oldest evicted on 6th add).
 * - 10-minute TTL: getRecent() filters stale entries before returning.
 * - getRecent() returns entries newest-first.
 * - Strict userId isolation — User A cannot see User B's entries.
 * - record() is synchronous and never throws due to persistence errors.
 */

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type pino from 'pino';
import { atomicWrite } from '../../utils/file.js';
import { withFileLock } from '../../utils/file-mutex.js';

/** A single recorded interaction event. */
export interface InteractionEntry {
	/** The app that generated this interaction (e.g. 'food', 'notes'). */
	appId: string;
	/** What the user/app did (e.g. 'capture-receipt', 'view-recipe'). */
	action: string;
	/** Semantic type of the primary entity involved (e.g. 'receipt', 'recipe'). */
	entityType?: string;
	/** Stable identifier for the primary entity. */
	entityId?: string;
	/** Canonical data file paths written or referenced during this interaction. */
	filePaths?: string[];
	/** Data scope of the interaction. */
	scope?: 'user' | 'shared' | 'space';
	/** Space ID when scope is 'space'. */
	spaceId?: string;
	/** Arbitrary key/value metadata for downstream context resolution. */
	metadata?: Record<string, string>;
	/** Unix timestamp (ms) when this entry was recorded. Set by record(). */
	timestamp: number;
}

/** Public interface for the interaction context service. */
export interface InteractionContextService {
	/**
	 * Record a new interaction for the given user.
	 * Timestamp is stamped automatically.
	 * When the buffer reaches 6 entries, the oldest is evicted.
	 */
	record(userId: string, entry: Omit<InteractionEntry, 'timestamp'>): void;

	/**
	 * Return recent interactions for the given user, newest-first.
	 * Entries older than 10 minutes are excluded.
	 * Returns an empty array for unknown users.
	 */
	getRecent(userId: string): InteractionEntry[];

	/**
	 * Load persisted entries from disk (no-op in in-memory mode).
	 * Should be called at startup before the service handles any messages.
	 */
	loadFromDisk(): Promise<void>;

	/**
	 * Cancel the debounce timer and immediately write current state to disk.
	 * No-op in in-memory mode.
	 */
	flush(): Promise<void>;

	/**
	 * Gracefully stop: set stopping flag, flush remaining writes, drain queue.
	 * No-op in in-memory mode.
	 */
	stop(): Promise<void>;
}

/** Constructor options for InteractionContextServiceImpl. */
export interface InteractionContextOptions {
	/** If omitted, the service operates in in-memory mode with no disk I/O. */
	dataDir?: string;
	/** Pino-compatible logger. */
	logger?: pino.Logger;
	/** Debounce delay before flushing to disk. Defaults to 500ms. */
	flushDelayMs?: number;
	/** Injectable writer for testing. Defaults to atomicWrite. */
	writer?: (path: string, content: string) => Promise<void>;
	/** Injectable clock for testing. Defaults to Date.now. */
	clock?: () => number;
}

/** Maximum number of entries retained per user (circular buffer size). */
const BUFFER_SIZE = 5;
/** Entry time-to-live in milliseconds (10 minutes). */
const TTL_MS = 10 * 60 * 1000;
/** Valid scope values for InteractionEntry. */
const VALID_SCOPES = new Set(['user', 'shared', 'space']);

/** Type guard that validates an InteractionEntry from untrusted data. */
function isValidEntry(value: unknown): value is InteractionEntry {
	if (typeof value !== 'object' || value === null) return false;
	const obj = value as Record<string, unknown>;

	if (typeof obj['appId'] !== 'string') return false;
	if (typeof obj['action'] !== 'string') return false;
	if (typeof obj['timestamp'] !== 'number') return false;
	if (!isFinite(obj['timestamp']) || obj['timestamp'] <= 0) return false;

	if (obj['scope'] !== undefined && (typeof obj['scope'] !== 'string' || !VALID_SCOPES.has(obj['scope']))) return false;
	if (obj['filePaths'] !== undefined && !Array.isArray(obj['filePaths'])) return false;
	if (obj['filePaths'] !== undefined) {
		for (const fp of obj['filePaths'] as unknown[]) {
			if (typeof fp !== 'string') return false;
		}
	}
	if (obj['metadata'] !== undefined) {
		if (typeof obj['metadata'] !== 'object' || obj['metadata'] === null) return false;
		for (const v of Object.values(obj['metadata'] as Record<string, unknown>)) {
			if (typeof v !== 'string') return false;
		}
	}

	return true;
}

/** Shape of the persisted JSON file. */
interface PersistedData {
	version: 1;
	users: Record<string, InteractionEntry[]>;
}

export class InteractionContextServiceImpl implements InteractionContextService {
	/** Per-user circular buffers. Entries are stored oldest-first internally. */
	private readonly store = new Map<string, InteractionEntry[]>();

	private readonly dataDir: string | undefined;
	private readonly logger: pino.Logger | undefined;
	private readonly flushDelayMs: number;
	private readonly writer: (path: string, content: string) => Promise<void>;
	private readonly clock: () => number;
	private readonly persistPath: string;

	private revision = 0;
	private flushedRevision = 0;
	private flushTimer: NodeJS.Timeout | null = null;
	private writeQueue: Promise<void> = Promise.resolve();
	private stopping = false;
	private dirEnsured = false;

	constructor(options: InteractionContextOptions = {}) {
		this.dataDir = options.dataDir;
		this.logger = options.logger;
		this.flushDelayMs = options.flushDelayMs ?? 500;
		this.writer = options.writer ?? atomicWrite;
		this.clock = options.clock ?? (() => Date.now());
		this.persistPath = this.dataDir
			? join(this.dataDir, 'system', 'interaction-context.json')
			: '';
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	record(userId: string, entry: Omit<InteractionEntry, 'timestamp'>): void {
		const stamped: InteractionEntry = { ...entry, timestamp: this.clock() };

		let buffer = this.store.get(userId);
		if (!buffer) {
			buffer = [];
			this.store.set(userId, buffer);
		}

		buffer.push(stamped);

		// Evict oldest if buffer exceeds capacity
		if (buffer.length > BUFFER_SIZE) {
			buffer.shift();
		}

		this.revision++;
		this.scheduleFlush();
	}

	getRecent(userId: string): InteractionEntry[] {
		const buffer = this.store.get(userId);
		if (!buffer || buffer.length === 0) {
			return [];
		}

		const cutoff = this.clock() - TTL_MS;

		// Filter expired entries and return newest-first
		return buffer.filter((e) => e.timestamp > cutoff).toReversed();
	}

	async loadFromDisk(): Promise<void> {
		if (!this.dataDir) return;

		let raw: string;
		try {
			raw = await readFile(this.persistPath, 'utf-8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				// First run — start empty silently
				return;
			}
			// Any other I/O error (EACCES, EMFILE, etc.) — log and start empty
			this.logger?.warn(
				{ path: this.persistPath, err },
				'interaction-context: failed to read persistence file; starting empty',
			);
			return;
		}

		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch (parseErr) {
			// Create .corrupt sidecar
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			const corruptPath = `${this.persistPath}.${ts}.corrupt`;
			try {
				await copyFile(this.persistPath, corruptPath);
			} catch {
				// Best-effort; ignore copyFile failure
			}
			this.logger?.warn(
				{ path: this.persistPath, err: parseErr },
				'interaction-context: corrupt JSON on load; starting empty',
			);
			return;
		}

		const obj = data as Record<string, unknown>;
		if (obj['version'] !== 1) {
			this.logger?.warn(
				{ path: this.persistPath, version: obj['version'] },
				'interaction-context: unknown version; starting empty',
			);
			return;
		}

		const users = obj['users'];
		if (typeof users !== 'object' || users === null || Array.isArray(users)) {
			this.logger?.warn(
				{ path: this.persistPath },
				'interaction-context: malformed users object; starting empty',
			);
			return;
		}

		const usersMap = users as Record<string, unknown>;

		for (const [userId, rawEntries] of Object.entries(usersMap)) {
			if (!Array.isArray(rawEntries)) continue;

			const valid: InteractionEntry[] = [];
			let dropped = 0;
			for (const e of rawEntries) {
				if (isValidEntry(e)) {
					valid.push(e);
				} else {
					dropped++;
				}
			}

			if (dropped > 0) {
				this.logger?.warn(
					{ userId, dropped },
					'interaction-context: dropped invalid entries on load',
				);
			}

			if (valid.length === 0) continue;

			// Enforce buffer cap (keep newest 5 by highest timestamp)
			const capped =
				valid.length > BUFFER_SIZE
					? valid.slice().sort((a, b) => a.timestamp - b.timestamp).slice(-BUFFER_SIZE)
					: valid;

			this.store.set(userId, capped);
		}

		// Prune expired entries using the shared helper (avoids duplicating TTL logic)
		this.pruneExpired(this.clock());

		// Remove users left with empty buffers after pruning
		for (const [userId, buffer] of this.store) {
			if (buffer.length === 0) this.store.delete(userId);
		}
	}

	async flush(): Promise<void> {
		if (!this.dataDir) return;
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.enqueueFlush();
		await this.writeQueue;
	}

	async stop(): Promise<void> {
		if (!this.dataDir) return;
		this.stopping = true;
		try {
			await this.flush();
		} catch (err) {
			this.logger?.warn(
				{ err, path: this.persistPath },
				'interaction-context: stop flush failed',
			);
		}
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	private scheduleFlush(): void {
		if (!this.dataDir) return;
		if (this.stopping) return;
		if (this.flushTimer !== null) return;

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.enqueueFlush();
		}, this.flushDelayMs);
	}

	private enqueueFlush(): void {
		this.writeQueue = this.writeQueue
			.then(() => this._doFlush())
			.catch((err: unknown) => this._logFlushError(err));
	}

	private async _doFlush(): Promise<void> {
		const revisionAtSnapshot = this.revision;

		// Prune expired entries in-place
		this.pruneExpired(this.clock());

		// Remove users with empty buffers
		for (const [userId, buffer] of this.store) {
			if (buffer.length === 0) this.store.delete(userId);
		}

		// Serialize
		const usersObj: Record<string, InteractionEntry[]> = {};
		for (const [userId, buffer] of this.store) {
			usersObj[userId] = buffer;
		}
		const json = JSON.stringify({ version: 1, users: usersObj }, null, 2);

		// Ensure system dir exists (once per process lifetime), then write atomically under file lock
		if (!this.dirEnsured) {
			await mkdir(dirname(this.persistPath), { recursive: true });
			this.dirEnsured = true;
		}
		await withFileLock(this.persistPath, () => this.writer(this.persistPath, json));

		this.flushedRevision = revisionAtSnapshot;

		// If new writes arrived while we were flushing, schedule a follow-up
		if (this.revision > this.flushedRevision) {
			this.enqueueFlush();
		}
	}

	private _logFlushError(err: unknown): void {
		this.logger?.error(
			{ err, path: this.persistPath },
			'interaction-context: flush failed',
		);
	}

	/** Prune expired entries in-place across all users. */
	private pruneExpired(now: number): void {
		const cutoff = now - TTL_MS;
		for (const [userId, buffer] of this.store) {
			const alive = buffer.filter((e) => e.timestamp > cutoff);
			if (alive.length !== buffer.length) {
				this.store.set(userId, alive);
			}
		}
	}
}
