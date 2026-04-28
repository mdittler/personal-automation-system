import type { Logger } from 'pino';
import type { DataStoreService } from '../../types/data-store.js';
import type { MemorySnapshot } from '../../types/conversation-session.js';
import { parseMemorySnapshotFrontmatter, toMemorySnapshotFrontmatter } from '../prompt-assembly/memory-context.js';
import { withFileLock } from '../../utils/file-mutex.js';
import { CorruptTranscriptError } from './errors.js';
import { mintSessionId } from './session-id.js';
import { getActive, setActiveUnlocked, clearActive } from './session-index.js';
import type { ActiveSessionEntry } from './session-index.js';
import { encodeNew, encodeAppend, decode } from './transcript-codec.js';
import type { ChatTranscriptIndex } from '../chat-transcript-index/index.js';

export interface ChatSessionFrontmatter {
	id: string;
	source: 'telegram' | 'legacy-import';
	user_id: string;
	household_id: string | null;
	model: string | null;
	title: string | null;
	parent_session_id: string | null;
	started_at: string;
	ended_at: string | null;
	token_counts: { input: number; output: number };
	/** Durable MemorySnapshot frozen at session-mint time (P4). Snake_case on disk. */
	memory_snapshot?: { content: string; status: 'ok' | 'empty' | 'degraded'; built_at: string; entry_count: number };
}

export interface SessionTurn {
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
	tokens?: { input?: number; output?: number };
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
	 */
	ensureActiveSession(
		ctx: { userId: string; sessionKey: string; model?: string; householdId?: string | null },
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
		},
		userTurn: SessionTurn,
		assistantTurn: SessionTurn,
	): Promise<{ sessionId: string }>;

	/** Read-only. Returns up to opts.maxTurns from the active session, or [] if none. */
	loadRecentTurns(
		ctx: { userId: string; sessionKey: string; householdId?: string | null },
		opts?: { maxTurns?: number },
	): Promise<SessionTurn[]>;

	/** Sets ended_at on the active transcript and clears the index entry. Idempotent. */
	endActive(
		ctx: { userId: string; sessionKey: string },
		reason: 'newchat' | 'reset' | 'system',
	): Promise<{ endedSessionId: string | null }>;

	/** Read any session by id. Validates id format. Returns undefined if missing. */
	readSession(
		userId: string,
		sessionId: string,
	): Promise<{ meta: ChatSessionFrontmatter; turns: SessionTurn[] } | undefined>;
}

const SESSION_ID_RE = /^\d{8}_\d{6}_[0-9a-f]{8}$/;
const MAX_MINT_ATTEMPTS = 3;

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

	async peekActive({ userId, sessionKey }: { userId: string; sessionKey: string }): Promise<string | undefined> {
		const store = this.deps.data.forUser(userId);
		const entry = await getActive(store, userId, sessionKey);
		return entry?.id;
	}

	async ensureActiveSession(
		ctx: { userId: string; sessionKey: string; model?: string; householdId?: string | null },
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
					snapshot = { content: '', status: 'degraded', builtAt: this.now().toISOString(), entryCount: 0 };
					memorySnapshotFm = toMemorySnapshotFrontmatter(snapshot);
				}
			}

			const sessionId = await this.mintAndRegisterWithSnapshot(store, ctx, memorySnapshotFm);
			return { sessionId, isNew: true, snapshot };
		});
	}

	async peekSnapshot(ctx: { userId: string; sessionKey: string }): Promise<MemorySnapshot | undefined> {
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
				throw new Error(`conversation-session: expected session ${ctx.expectedSessionId} not found`);
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
			const base = raw === '' ? encodeNew(this.buildFrontmatter(ctx, sessionId)) : raw;
			// Compute turn_index for index writes: count existing turns before appending.
			// Only decode when the index is wired AND the file already has content.
			if (this.deps.index && raw !== '') {
				try {
					const { turns } = decode(raw);
					userTurnIndex = turns.length;
				} catch {
					// Corrupt — fall back to 0; INSERT OR IGNORE in appendMessage makes safe
					userTurnIndex = 0;
				}
			}
			const next = encodeAppend(encodeAppend(base, userTurn), assistantTurn);
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
				this.deps.logger.warn({ err, sessionId }, 'chat-transcript-index: appendMessage failed; continuing');
			}
		}

		return { sessionId };
	}

	// Must be called while the caller holds the conversation-session-index:<userId> lock.
	private async mintAndRegister(
		store: ReturnType<DataStoreService['forUser']>,
		ctx: { userId: string; sessionKey: string; model?: string; householdId?: string | null },
	): Promise<string> {
		return this.mintAndRegisterWithSnapshot(store, ctx, undefined);
	}

	// Must be called while the caller holds the conversation-session-index:<userId> lock.
	private async mintAndRegisterWithSnapshot(
		store: ReturnType<DataStoreService['forUser']>,
		ctx: { userId: string; sessionKey: string; model?: string; householdId?: string | null },
		memorySnapshot: ChatSessionFrontmatter['memory_snapshot'],
	): Promise<string> {
		const now = this.now();
		const startedAt = now.toISOString();
		for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
			const id = this.mintId(now);
			const existing = await store.read(`conversation/sessions/${id}.md`);
			if (existing === '') {
				const fm = this.buildFrontmatter(ctx, id, startedAt);
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
						});
					} catch (err) {
						this.deps.logger.warn({ err, sessionId: id }, 'chat-transcript-index: upsertSession failed; continuing');
					}
				}
				await setActiveUnlocked(store, ctx.sessionKey, { id, started_at: startedAt, model: ctx.model ?? null });
				return id;
			}
			this.deps.logger.warn({ id, attempt }, 'conversation-session: id collision, retrying');
		}
		throw new Error(`conversation-session: unable to mint a unique session id after ${MAX_MINT_ATTEMPTS} attempts`);
	}

	private buildFrontmatter(
		ctx: { userId: string; model?: string; householdId?: string | null },
		sessionId: string,
		startedAt?: string,
	): ChatSessionFrontmatter {
		return {
			id: sessionId,
			source: 'telegram',
			user_id: ctx.userId,
			household_id: ctx.householdId ?? null,
			model: ctx.model ?? null,
			title: null,
			parent_session_id: null,
			started_at: startedAt ?? this.now().toISOString(),
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
		ctx: { userId: string; sessionKey: string },
		reason: 'newchat' | 'reset' | 'system',
	): Promise<{ endedSessionId: string | null }> {
		const store = this.deps.data.forUser(ctx.userId);
		const entry = await getActive(store, ctx.userId, ctx.sessionKey);
		if (!entry) return { endedSessionId: null };
		this.deps.logger.debug({ sessionId: entry.id, reason }, 'conversation-session: ending active session');

		let endedAt: string | null = null;
		await withFileLock(`conversation-session-transcript:${ctx.userId}:${entry.id}`, async () => {
			const path = `conversation/sessions/${entry.id}.md`;
			const raw = await store.read(path);
			if (raw === '') return;
			let decoded: { meta: ChatSessionFrontmatter; turns: SessionTurn[] };
			try {
				decoded = decode(raw);
			} catch (err) {
				if (err instanceof CorruptTranscriptError) {
					this.deps.logger.warn({ sessionId: entry.id, err }, 'conversation-session: corrupt transcript on endActive');
					return;
				}
				throw err;
			}
			endedAt = this.now().toISOString();
			decoded.meta.ended_at = endedAt;
			let next = encodeNew(decoded.meta);
			for (const t of decoded.turns) next = encodeAppend(next, t);
			await store.write(path, next);
		});

		await clearActive(store, ctx.userId, ctx.sessionKey);

		if (this.deps.index && endedAt !== null) {
			const endedSessionId = entry.id;
			const endedAtStr = endedAt;
			try {
				await this.deps.index.endSession(endedSessionId, endedAtStr);
			} catch (err) {
				this.deps.logger.warn({ err, endedSessionId }, 'chat-transcript-index: endSession failed; continuing');
			}
		}

		return { endedSessionId: entry.id };
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
				this.deps.logger.warn({ userId }, 'conversation-session: legacy history.json malformed JSON, skipping migration');
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
				this.deps.logger.warn({ userId }, 'conversation-session: could not mint unique id for legacy migration');
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
					this.deps.logger.warn({ err, sessionId }, 'chat-transcript-index: upsertSession (legacy) failed; continuing');
				}
			}

			await store.write(sentinelPath, this.now().toISOString());
		});
	}
}
