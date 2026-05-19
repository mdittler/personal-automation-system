import type { Logger } from 'pino';
import type { MemorySnapshot } from '../../types/conversation-session.js';
import type { DataStoreService } from '../../types/data-store.js';
import { withFileLock, withMultiFileLock } from '../../utils/file-mutex.js';
import type { ChatTranscriptIndex } from '../chat-transcript-index/index.js';
import {
	parseMemorySnapshotFrontmatter,
	toMemorySnapshotFrontmatter,
} from '../prompt-assembly/memory-context.js';
import { CorruptTranscriptError, NoActiveSessionError, SessionCasMismatchError } from './errors.js';
import { mintSessionId } from './session-id.js';
import { clearActive, getActive, setActiveUnlocked } from './session-index.js';
import type { ActiveSessionEntry } from './session-index.js';
import { decode, encodeAppend, encodeNew } from './transcript-codec.js';

export interface ChatSessionFrontmatter {
	id: string;
	source: 'telegram' | 'legacy-import';
	user_id: string;
	household_id: string | null;
	model: string | null;
	title: string | null;
	parent_session_id: string | null;
	started_at: string;
	/** Refreshed on every appendExchange. Falls back to started_at on read for legacy transcripts. */
	last_activity_at?: string;
	ended_at: string | null;
	token_counts: { input: number; output: number };
	/** Durable MemorySnapshot frozen at session-mint time (P4). Snake_case on disk. */
	memory_snapshot?: {
		content: string;
		status: 'ok' | 'empty' | 'degraded';
		built_at: string;
		entry_count: number;
	};
}

/**
 * Provenance label set by every new write path. Optional for back-compat with
 * legacy transcripts written before this field existed.
 *   - 'user' / 'assistant' — typed user-bot exchange (dispatchMessage / dispatchConversation / handle-message / handle-ask)
 *   - 'photo'              — photo-handler PhotoSummary bridge (dispatchPhoto, both turns)
 *   - 'app'                — AppOutboundBridge proactive-message bridge (both turns)
 * The fencing layer uses this field to authorise cap-lift in
 * `formatConversationHistory`. When undefined (legacy transcript only),
 * fencing falls back to content-regex against PHOTO_TURN_HEADERS / APP_HEADER_RE.
 */
export type SessionTurnSource = 'user' | 'assistant' | 'photo' | 'app';

export interface SessionTurn {
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
	tokens?: { input?: number; output?: number };
	source?: SessionTurnSource;
}

export interface ChatSessionStore {
	/** Read-only. Returns the active session id, or undefined if none. NEVER mints. */
	peekActive(ctx: { userId: string; sessionKey: string }): Promise<string | undefined>;

	/**
	 * Ensure an active session exists — minting one if needed — and return the
	 * session id and any frozen MemorySnapshot.
	 *
	 * Called BEFORE prompt assembly so the first turn sees Layer 2 durable memory.
	 * On the mint path, `opts.buildSnapshot` is invoked once (try/catch → degraded).
	 * On the peek path (existing session), the snapshot is read from frontmatter.
	 * When `opts.buildSnapshot` is absent, no memory_snapshot field is written.
	 * When `ctx.parentSessionId` is provided, it is format-validated and stamped on the
	 * new transcript's frontmatter (P8c lineage).
	 */
	ensureActiveSession(
		ctx: {
			userId: string;
			sessionKey: string;
			model?: string;
			householdId?: string | null;
			parentSessionId?: string | null;
		},
		opts?: { buildSnapshot?: () => Promise<MemorySnapshot> },
	): Promise<{ sessionId: string; isNew: boolean; snapshot: MemorySnapshot | undefined }>;

	/**
	 * Read-only. Returns the frozen MemorySnapshot from the active session's
	 * frontmatter, or undefined if no active session or no snapshot field.
	 */
	peekSnapshot(ctx: { userId: string; sessionKey: string }): Promise<MemorySnapshot | undefined>;

	/**
	 * Atomic mint-or-reuse + write of one user/assistant exchange.
	 *
	 * If `expectedSessionId` is provided, the append targets that exact session
	 * (the in-flight `/ask` race case where Router bound the id before
	 * `/newchat` ended the session). Throws if that session does not exist.
	 */
	appendExchange(
		ctx: {
			userId: string;
			sessionKey: string;
			model?: string;
			householdId?: string | null;
			expectedSessionId?: string;
			parentSessionId?: string | null;
		},
		userTurn: SessionTurn,
		assistantTurn: SessionTurn,
	): Promise<{ sessionId: string }>;

	/** Read-only. Returns up to opts.maxTurns from the active session, or [] if none. */
	loadRecentTurns(
		ctx: { userId: string; sessionKey: string; householdId?: string | null },
		opts?: { maxTurns?: number },
	): Promise<SessionTurn[]>;

	/**
	 * Sets ended_at on the active transcript and clears the index entry.
	 *
	 * When `expectedSessionId` is provided, the clear is compare-and-swap: if the
	 * currently-active session id does not match, no changes are made and
	 * `endedSessionId` is returned as `null`. This prevents the idle-reset hook from
	 * accidentally ending a fresh session that was minted after the hook peeked.
	 */
	endActive(
		ctx: { userId: string; sessionKey: string; expectedSessionId?: string },
		reason: 'newchat' | 'reset' | 'system' | 'idle',
	): Promise<{ endedSessionId: string | null }>;

	/** Read any session by id. Validates id format. Returns undefined if missing. */
	readSession(
		userId: string,
		sessionId: string,
	): Promise<{ meta: ChatSessionFrontmatter; turns: SessionTurn[] } | undefined>;

	/**
	 * Set a human-readable title on an existing session transcript.
	 *
	 * Sanitizes the input (strips control chars, collapses whitespace, truncates
	 * at 80 chars). Returns `{ updated: false }` for empty/whitespace-only titles,
	 * missing session files, or corrupt transcripts (with a logger.warn in the
	 * latter two cases). When `opts.skipIfTitled` is true, the write is skipped if
	 * the session already has a non-empty title.
	 * When the write succeeds, returns `{ updated: true, title: <sanitized> }`.
	 */
	setTitle(
		userId: string,
		sessionId: string,
		title: string,
		opts?: { skipIfTitled?: boolean },
	): Promise<{ updated: boolean; title?: string }>;

	/**
	 * Rebuild the active session's MemorySnapshot in-place.
	 *
	 * Double-CAS pattern (REQ-CONV-MEMORY-016, REQ-CONV-MEMORY-017):
	 *   1. Under index lock: verify active session matches expectedSessionId
	 *   2. Call buildSnapshot() OUTSIDE all locks
	 *   3. Under multi-lock (index + transcript, sorted order): re-read index
	 *      to catch in-flight session changes, then write updated frontmatter
	 *
	 * Always writes on success (REQ-CONV-MEMORY-020): built_at always reflects
	 * the rebuild time even when content is identical to the prior snapshot.
	 *
	 * Throws NoActiveSessionError if no session is active.
	 * Throws SessionCasMismatchError if the active session changed mid-rebuild.
	 * Propagates buildSnapshot() errors without writing (fail-soft caller contract).
	 */
	rebuildMemorySnapshot(
		ctx: { userId: string; sessionKey: string },
		opts: {
			buildSnapshot: () => Promise<MemorySnapshot>;
			expectedSessionId?: string;
		},
	): Promise<MemorySnapshot>;
}

const SESSION_ID_RE = /^\d{8}_\d{6}_[0-9a-f]{8}$/;
const MAX_MINT_ATTEMPTS = 3;
const TITLE_MAX_LEN = 80;

function validateParentSessionId(input: unknown, sessionId: string, logger: Logger): string | null {
	if (input === null || input === undefined) return null;
	if (typeof input !== 'string') return null;
	if (!SESSION_ID_RE.test(input)) {
		logger.warn(
			{ suspectedParentSessionId: input, sessionId },
			'conversation-session: parentSessionId rejected — does not match SESSION_ID_RE',
		);
		return null;
	}
	return input;
}

function sanitizeTitle(input: string): string | null {
	const cleaned = input
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/[\u0000-\u001F\u007F]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length === 0) return null;
	return cleaned.slice(0, TITLE_MAX_LEN);
}

export class DefaultChatSessionStore implements ChatSessionStore {
	constructor(
		private readonly deps: {
			data: DataStoreService;
			logger: Logger;
			clock?: () => Date;
			rng?: () => string;
			index?: ChatTranscriptIndex;
		},
	) {}

	private now(): Date {
		return this.deps.clock?.() ?? new Date();
	}

	private mintId(now: Date): string {
		return mintSessionId(now, this.deps.rng);
	}

	async peekActive({
		userId,
		sessionKey,
	}: { userId: string; sessionKey: string }): Promise<string | undefined> {
		const store = this.deps.data.forUser(userId);
		const entry = await getActive(store, userId, sessionKey);
		return entry?.id;
	}

	async ensureActiveSession(
		ctx: {
			userId: string;
			sessionKey: string;
			model?: string;
			householdId?: string | null;
			parentSessionId?: string | null;
		},
		opts?: { buildSnapshot?: () => Promise<MemorySnapshot> },
	): Promise<{ sessionId: string; isNew: boolean; snapshot: MemorySnapshot | undefined }> {
		const store = this.deps.data.forUser(ctx.userId);
		await this.maybeImportLegacy(store, ctx.userId, ctx.householdId ?? null);

		return withFileLock(`conversation-session-index:${ctx.userId}`, async () => {
			const existing = await getActive(store, ctx.userId, ctx.sessionKey);
			if (existing) {
				// Peek path: read snapshot from frontmatter
				const raw = await store.read(`conversation/sessions/${existing.id}.md`);
				let snapshot: MemorySnapshot | undefined;
				if (raw !== '') {
					try {
						const { meta } = decode(raw);
						snapshot = parseMemorySnapshotFrontmatter(meta.memory_snapshot);
					} catch {
						// Corrupt transcript — return without snapshot
					}
				}
				return { sessionId: existing.id, isNew: false, snapshot };
			}

			// Mint path: build snapshot (if callback provided), then mint session
			let snapshot: MemorySnapshot | undefined;
			let memorySnapshotFm: ChatSessionFrontmatter['memory_snapshot'] | undefined;
			if (opts?.buildSnapshot) {
				try {
					snapshot = await opts.buildSnapshot();
					memorySnapshotFm = toMemorySnapshotFrontmatter(snapshot);
				} catch (err) {
					this.deps.logger.warn(
						{ err },
						'conversation-session: buildSnapshot failed — minting with degraded snapshot',
					);
					snapshot = {
						content: '',
						status: 'degraded',
						builtAt: this.now().toISOString(),
						entryCount: 0,
					};
					memorySnapshotFm = toMemorySnapshotFrontmatter(snapshot);
				}
			}

			const sessionId = await this.mintAndRegisterWithSnapshot(
				store,
				ctx,
				memorySnapshotFm,
				ctx.parentSessionId ?? null,
			);
			return { sessionId, isNew: true, snapshot };
		});
	}

	async peekSnapshot(ctx: { userId: string; sessionKey: string }): Promise<
		MemorySnapshot | undefined
	> {
		const store = this.deps.data.forUser(ctx.userId);
		const entry = await getActive(store, ctx.userId, ctx.sessionKey);
		if (!entry) return undefined;
		const raw = await store.read(`conversation/sessions/${entry.id}.md`);
		if (raw === '') return undefined;
		try {
			const { meta } = decode(raw);
			return parseMemorySnapshotFrontmatter(meta.memory_snapshot);
		} catch {
			return undefined;
		}
	}

	async appendExchange(
		ctx: {
			userId: string;
			sessionKey: string;
			model?: string;
			householdId?: string | null;
			expectedSessionId?: string;
			parentSessionId?: string | null;
		},
		userTurn: SessionTurn,
		assistantTurn: SessionTurn,
	): Promise<{ sessionId: string }> {
		const store = this.deps.data.forUser(ctx.userId);
		await this.maybeImportLegacy(store, ctx.userId, ctx.householdId ?? null);

		let sessionId: string;
		if (ctx.expectedSessionId) {
			// In-flight race path: the Router bound this id before /newchat ended the session.
			// Target the exact session — throw if the file was never written.
			const raw = await store.read(`conversation/sessions/${ctx.expectedSessionId}.md`);
			if (raw === '') {
				throw new Error(
					`conversation-session: expected session ${ctx.expectedSessionId} not found`,
				);
			}
			sessionId = ctx.expectedSessionId;
		} else {
			// Normal path: reuse active session or mint a new one (under index lock).
			sessionId = await withFileLock(`conversation-session-index:${ctx.userId}`, async () => {
				const existing = await getActive(store, ctx.userId, ctx.sessionKey);
				if (existing) return existing.id;
				return this.mintAndRegister(store, ctx);
			});
		}

		// Append both turns under the transcript lock.
		let userTurnIndex = 0;
		await withFileLock(`conversation-session-transcript:${ctx.userId}:${sessionId}`, async () => {
			const path = `conversation/sessions/${sessionId}.md`;
			const raw = await store.read(path);
			let next: string;
			if (raw === '') {
				// Brand-new file: build from scratch (no existing turns, no bump needed).
				next = encodeAppend(
					encodeAppend(encodeNew(this.buildFrontmatter(ctx, sessionId)), userTurn),
					assistantTurn,
				);
			} else {
				// Existing file: decode so we can bump last_activity_at and capture userTurnIndex.
				try {
					const { meta, turns } = decode(raw);
					userTurnIndex = turns.length;
					// Don't bump last_activity_at on an already-ended session (in-flight race path).
					if (!meta.ended_at) meta.last_activity_at = this.now().toISOString();
					let rebuilt = encodeNew(meta);
					for (const t of turns) rebuilt = encodeAppend(rebuilt, t);
					next = encodeAppend(encodeAppend(rebuilt, userTurn), assistantTurn);
				} catch (err) {
					// Corrupt transcript — fall back to raw append; don't bump last_activity_at.
					// userTurnIndex stays 0; INSERT OR IGNORE in appendMessage makes this safe.
					this.deps.logger.warn(
						{ err, sessionId, userId: ctx.userId },
						'conversation-session: decode failed in appendExchange; falling back to raw append',
					);
					next = encodeAppend(encodeAppend(raw, userTurn), assistantTurn);
				}
			}
			await store.write(path, next);
		});

		if (this.deps.index) {
			const assistantTurnIndex = userTurnIndex + 1;
			try {
				await Promise.all([
					this.deps.index.appendMessage({
						session_id: sessionId,
						turn_index: userTurnIndex,
						role: 'user',
						content: userTurn.content,
						timestamp: userTurn.timestamp,
					}),
					this.deps.index.appendMessage({
						session_id: sessionId,
						turn_index: assistantTurnIndex,
						role: 'assistant',
						content: assistantTurn.content,
						timestamp: assistantTurn.timestamp,
					}),
				]);
			} catch (err) {
				this.deps.logger.warn(
					{ err, sessionId },
					'chat-transcript-index: appendMessage failed; continuing',
				);
			}
		}

		return { sessionId };
	}

	// Must be called while the caller holds the conversation-session-index:<userId> lock.
	private async mintAndRegister(
		store: ReturnType<DataStoreService['forUser']>,
		ctx: {
			userId: string;
			sessionKey: string;
			model?: string;
			householdId?: string | null;
			parentSessionId?: string | null;
		},
	): Promise<string> {
		return this.mintAndRegisterWithSnapshot(store, ctx, undefined, ctx.parentSessionId ?? null);
	}

	// Must be called while the caller holds the conversation-session-index:<userId> lock.
	private async mintAndRegisterWithSnapshot(
		store: ReturnType<DataStoreService['forUser']>,
		ctx: { userId: string; sessionKey: string; model?: string; householdId?: string | null },
		memorySnapshot: ChatSessionFrontmatter['memory_snapshot'],
		parentSessionId: string | null = null,
	): Promise<string> {
		const now = this.now();
		const startedAt = now.toISOString();
		for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
			const id = this.mintId(now);
			const existing = await store.read(`conversation/sessions/${id}.md`);
			if (existing === '') {
				const validatedParent = validateParentSessionId(parentSessionId, id, this.deps.logger);
				const fm = this.buildFrontmatter(ctx, id, startedAt, validatedParent);
				if (memorySnapshot !== undefined) fm.memory_snapshot = memorySnapshot;
				// Write transcript skeleton BEFORE publishing to the index.
				// Guarantees concurrent peekActive + expectedSessionId callers always find an existing file.
				await store.write(`conversation/sessions/${id}.md`, encodeNew(fm));
				if (this.deps.index) {
					try {
						await this.deps.index.upsertSession({
							id,
							user_id: ctx.userId,
							household_id: ctx.householdId ?? null,
							source: 'telegram',
							started_at: startedAt,
							ended_at: null,
							model: ctx.model ?? null,
							title: null,
							parent_session_id: validatedParent,
						});
					} catch (err) {
						this.deps.logger.warn(
							{ err, sessionId: id, parentSessionId: validatedParent },
							'chat-transcript-index: upsertSession failed; continuing',
						);
					}
				}
				await setActiveUnlocked(store, ctx.sessionKey, {
					id,
					started_at: startedAt,
					model: ctx.model ?? null,
				});
				return id;
			}
			this.deps.logger.warn({ id, attempt }, 'conversation-session: id collision, retrying');
		}
		throw new Error(
			`conversation-session: unable to mint a unique session id after ${MAX_MINT_ATTEMPTS} attempts`,
		);
	}

	private buildFrontmatter(
		ctx: { userId: string; model?: string; householdId?: string | null },
		sessionId: string,
		startedAt?: string,
		parentSessionId: string | null = null,
	): ChatSessionFrontmatter {
		const now = startedAt ?? this.now().toISOString();
		return {
			id: sessionId,
			source: 'telegram',
			user_id: ctx.userId,
			household_id: ctx.householdId ?? null,
			model: ctx.model ?? null,
			title: null,
			parent_session_id: parentSessionId,
			started_at: now,
			last_activity_at: now,
			ended_at: null,
			token_counts: { input: 0, output: 0 },
		};
	}

	async loadRecentTurns(
		ctx: { userId: string; sessionKey: string; householdId?: string | null },
		opts?: { maxTurns?: number },
	): Promise<SessionTurn[]> {
		const store = this.deps.data.forUser(ctx.userId);
		await this.maybeImportLegacy(store, ctx.userId, ctx.householdId ?? null);
		const entry = await getActive(store, ctx.userId, ctx.sessionKey);
		if (!entry) return [];
		const raw = await store.read(`conversation/sessions/${entry.id}.md`);
		if (raw === '') return [];
		try {
			const { turns } = decode(raw);
			const maxTurns = opts?.maxTurns ?? 20;
			return turns.slice(-maxTurns);
		} catch {
			return [];
		}
	}

	async endActive(
		ctx: { userId: string; sessionKey: string; expectedSessionId?: string },
		reason: 'newchat' | 'reset' | 'system' | 'idle',
	): Promise<{ endedSessionId: string | null }> {
		const store = this.deps.data.forUser(ctx.userId);

		// CAS under index lock: verify the active session hasn't changed since the caller's
		// peekActive snapshot. Do NOT clear yet — transcript must be written first to ensure
		// the index is never cleared without a corresponding ended_at in the transcript.
		let entry: ActiveSessionEntry | undefined;
		let mismatch = false;
		await withFileLock(`conversation-session-index:${ctx.userId}`, async () => {
			const found = await getActive(store, ctx.userId, ctx.sessionKey);
			if (!found) return;
			entry = found;
			if (ctx.expectedSessionId !== undefined && found.id !== ctx.expectedSessionId) {
				mismatch = true;
			}
		});

		if (!entry) return { endedSessionId: null };
		if (mismatch) {
			this.deps.logger.warn(
				{ userId: ctx.userId, expectedSessionId: ctx.expectedSessionId, actualId: entry.id },
				'conversation-session: endActive CAS mismatch — active session changed; aborting',
			);
			return { endedSessionId: null };
		}

		this.deps.logger.debug(
			{ sessionId: entry.id, reason },
			'conversation-session: ending active session',
		);

		// Write ended_at to transcript first. Track whether to clear the index entry.
		// If the transcript write throws, clearIndex stays false and the session remains
		// active — safe to retry. Only clear after a successful (or graceful no-op) write.
		let endedAt: string | null = null;
		let clearIndex = false;
		await withFileLock(`conversation-session-transcript:${ctx.userId}:${entry.id}`, async () => {
			const path = `conversation/sessions/${entry!.id}.md`;
			const raw = await store.read(path);
			if (raw === '') {
				clearIndex = true; // Dead index entry — remove, but no ended_at to set
				return;
			}
			let decoded: { meta: ChatSessionFrontmatter; turns: SessionTurn[] };
			try {
				decoded = decode(raw);
			} catch (err) {
				if (err instanceof CorruptTranscriptError) {
					this.deps.logger.warn(
						{ sessionId: entry!.id, err },
						'conversation-session: corrupt transcript on endActive',
					);
					clearIndex = true; // Corrupt — remove dead entry
					return;
				}
				throw err;
			}
			endedAt = this.now().toISOString();
			decoded.meta.ended_at = endedAt;
			let next = encodeNew(decoded.meta);
			for (const t of decoded.turns) next = encodeAppend(next, t);
			await store.write(path, next);
			clearIndex = true; // Set only after the write succeeds
		});

		// Clear the active index entry only after transcript outcome is confirmed.
		if (clearIndex) {
			await clearActive(store, ctx.userId, ctx.sessionKey);
		}

		if (this.deps.index && endedAt !== null) {
			const endedSessionId = entry.id;
			const endedAtStr = endedAt;
			try {
				await this.deps.index.endSession(endedSessionId, endedAtStr);
			} catch (err) {
				this.deps.logger.warn(
					{ err, endedSessionId },
					'chat-transcript-index: endSession failed; continuing',
				);
			}
		}

		return { endedSessionId: endedAt !== null ? entry.id : null };
	}

	async setTitle(
		userId: string,
		sessionId: string,
		title: string,
		opts: { skipIfTitled?: boolean } = {},
	): Promise<{ updated: boolean; title?: string }> {
		if (!SESSION_ID_RE.test(sessionId)) return { updated: false };

		const sanitized = sanitizeTitle(title);
		if (sanitized === null) return { updated: false };

		let updated = false;
		await withFileLock(`conversation-session-transcript:${userId}:${sessionId}`, async () => {
			const store = this.deps.data.forUser(userId);
			const path = `conversation/sessions/${sessionId}.md`;
			const raw = await store.read(path);
			if (raw === '') {
				this.deps.logger.warn(
					{ sessionId },
					'conversation-session: setTitle on missing session file',
				);
				return;
			}
			let decoded: { meta: ChatSessionFrontmatter; turns: SessionTurn[] };
			try {
				decoded = decode(raw);
			} catch (err) {
				if (err instanceof CorruptTranscriptError) {
					this.deps.logger.warn(
						{ sessionId, err },
						'conversation-session: corrupt transcript on setTitle',
					);
					return;
				}
				throw err;
			}
			if (
				opts.skipIfTitled &&
				typeof decoded.meta.title === 'string' &&
				decoded.meta.title.trim().length > 0
			) {
				return;
			}
			decoded.meta.title = sanitized;
			let next = encodeNew(decoded.meta);
			for (const t of decoded.turns) next = encodeAppend(next, t);
			await store.write(path, next);
			updated = true;
		});

		if (updated) return { updated: true, title: sanitized };
		return { updated: false };
	}

	async rebuildMemorySnapshot(
		ctx: { userId: string; sessionKey: string },
		opts: {
			buildSnapshot: () => Promise<MemorySnapshot>;
			expectedSessionId?: string;
		},
	): Promise<MemorySnapshot> {
		const store = this.deps.data.forUser(ctx.userId);

		let activeId: string | undefined;
		await withFileLock(`conversation-session-index:${ctx.userId}`, async () => {
			activeId = (await getActive(store, ctx.userId, ctx.sessionKey))?.id;
		});
		if (!activeId) throw new NoActiveSessionError();
		if (opts.expectedSessionId !== undefined && opts.expectedSessionId !== activeId) {
			throw new SessionCasMismatchError(
				`expectedSessionId ${opts.expectedSessionId} does not match active ${activeId}`,
			);
		}
		const sessionId = opts.expectedSessionId ?? activeId;

		const snapshot = await opts.buildSnapshot();

		await withMultiFileLock(
			[
				`conversation-session-index:${ctx.userId}`,
				`conversation-session-transcript:${ctx.userId}:${sessionId}`,
			],
			async () => {
				const recheckId = (await getActive(store, ctx.userId, ctx.sessionKey))?.id;
				if (recheckId !== sessionId) {
					this.deps.logger.warn(
						{ userId: ctx.userId, sessionId, recheckId },
						'rebuild-memory-snapshot: CAS recheck failed — session changed during rebuild',
					);
					throw new SessionCasMismatchError(
						`Session changed during rebuild: expected ${sessionId}, found ${recheckId ?? 'none'}`,
					);
				}

				const path = `conversation/sessions/${sessionId}.md`;
				const raw = await store.read(path);
				if (raw === '') {
					throw new Error(
						`conversation-session: rebuildMemorySnapshot — session file missing for ${sessionId}`,
					);
				}
				const { meta, turns } = decode(raw); // throws CorruptTranscriptError if corrupt
				if (meta.ended_at) {
					throw new SessionCasMismatchError(`Session ${sessionId} was ended during rebuild`);
				}
				meta.memory_snapshot = toMemorySnapshotFrontmatter(snapshot);
				meta.last_activity_at = this.now().toISOString();
				let next = encodeNew(meta);
				for (const t of turns) next = encodeAppend(next, t);
				await store.write(path, next);
			},
		);

		return snapshot;
	}

	async readSession(
		userId: string,
		sessionId: string,
	): Promise<{ meta: ChatSessionFrontmatter; turns: SessionTurn[] } | undefined> {
		if (!SESSION_ID_RE.test(sessionId)) return undefined;
		const raw = await this.deps.data.forUser(userId).read(`conversation/sessions/${sessionId}.md`);
		if (raw === '') return undefined;
		return decode(raw);
	}

	// Migrate legacy history.json once per user, under a per-user mutex.
	// After the first run (regardless of outcome), writes a sentinel file so
	// subsequent calls are O(1) rather than scanning the sessions directory.
	private async maybeImportLegacy(
		store: ReturnType<DataStoreService['forUser']>,
		userId: string,
		householdId: string | null,
	): Promise<void> {
		const sentinelPath = 'conversation/.legacy-checked';
		await withFileLock(`legacy-migration:${userId}`, async () => {
			// Fast path: already checked on a prior call
			if ((await store.read(sentinelPath)) !== '') return;

			// Upgrade compatibility: users who ran P3 before the sentinel was
			// introduced already have a source:legacy-import session but no
			// sentinel file. Scan once so we don't re-import their history.json.
			const sessionFiles = await store.list('conversation/sessions/');
			for (const filename of sessionFiles) {
				if (!filename.endsWith('.md')) continue;
				const raw = await store.read(`conversation/sessions/${filename}`);
				try {
					const { meta } = decode(raw);
					if (meta.source === 'legacy-import') {
						await store.write(sentinelPath, this.now().toISOString());
						return;
					}
				} catch {
					// Corrupt — skip this file
				}
			}

			// Read history.json
			const historyRaw = await store.read('history.json');
			if (!historyRaw) {
				await store.write(sentinelPath, this.now().toISOString());
				return;
			}

			let legacyTurns: Array<{ role: unknown; content: unknown; timestamp: unknown }>;
			try {
				const parsed = JSON.parse(historyRaw);
				if (!Array.isArray(parsed) || parsed.length === 0) {
					await store.write(sentinelPath, this.now().toISOString());
					return;
				}
				legacyTurns = parsed as typeof legacyTurns;
			} catch {
				this.deps.logger.warn(
					{ userId },
					'conversation-session: legacy history.json malformed JSON, skipping migration',
				);
				await store.write(sentinelPath, this.now().toISOString());
				return;
			}

			const isValidIso = (v: unknown): v is string =>
				typeof v === 'string' && !Number.isNaN(Date.parse(v));

			const firstTs = isValidIso(legacyTurns[0]?.timestamp)
				? legacyTurns[0].timestamp
				: this.now().toISOString();
			const lastTs = isValidIso(legacyTurns[legacyTurns.length - 1]?.timestamp)
				? (legacyTurns[legacyTurns.length - 1]!.timestamp as string)
				: this.now().toISOString();

			const startDate = isValidIso(legacyTurns[0]?.timestamp)
				? new Date(legacyTurns[0].timestamp)
				: this.now();

			let sessionId: string | undefined;
			for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
				const id = this.mintId(startDate);
				const existing = await store.read(`conversation/sessions/${id}.md`);
				if (existing === '') {
					sessionId = id;
					break;
				}
			}
			if (!sessionId) {
				this.deps.logger.warn(
					{ userId },
					'conversation-session: could not mint unique id for legacy migration',
				);
				await store.write(sentinelPath, this.now().toISOString());
				return;
			}

			// Build frontmatter (source: legacy-import, ended_at set to last turn ts)
			const meta: ChatSessionFrontmatter = {
				id: sessionId,
				source: 'legacy-import',
				user_id: userId,
				household_id: householdId,
				model: null,
				title: null,
				parent_session_id: null,
				started_at: firstTs,
				ended_at: lastTs,
				token_counts: { input: 0, output: 0 },
			};

			let content = encodeNew(meta);
			for (const t of legacyTurns) {
				const role: 'user' | 'assistant' = t.role === 'assistant' ? 'assistant' : 'user';
				const sessionTurn: SessionTurn = {
					role,
					content: String(t.content ?? ''),
					timestamp: isValidIso(t.timestamp) ? t.timestamp : this.now().toISOString(),
				};
				content = encodeAppend(content, sessionTurn);
			}

			await store.write(`conversation/sessions/${sessionId}.md`, content);

			if (this.deps.index) {
				try {
					await this.deps.index.upsertSession({
						id: sessionId,
						user_id: userId,
						household_id: householdId,
						source: 'legacy-import',
						started_at: firstTs,
						ended_at: lastTs,
						model: null,
						title: null,
						parent_session_id: null,
					});
					// Index each turn so FTS search can find legacy content.
					for (let i = 0; i < legacyTurns.length; i++) {
						const t = legacyTurns[i]!;
						const role: 'user' | 'assistant' = t.role === 'assistant' ? 'assistant' : 'user';
						await this.deps.index.appendMessage({
							session_id: sessionId,
							turn_index: i,
							role,
							content: String(t.content ?? ''),
							timestamp: isValidIso(t.timestamp) ? t.timestamp : this.now().toISOString(),
						});
					}
				} catch (err) {
					this.deps.logger.warn(
						{ err, sessionId },
						'chat-transcript-index: upsertSession (legacy) failed; continuing',
					);
				}
			}

			await store.write(sentinelPath, this.now().toISOString());
		});
	}
}
