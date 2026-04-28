import type { Logger } from 'pino';
import type { DataStoreService } from '../../types/data-store.js';
import { withFileLock } from '../../utils/file-mutex.js';
import { CorruptTranscriptError } from './errors.js';
import { mintSessionId } from './session-id.js';
import { getActive, setActiveUnlocked, clearActive } from './session-index.js';
import type { ActiveSessionEntry } from './session-index.js';
import { encodeNew, encodeAppend, decode } from './transcript-codec.js';

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
		ctx: { userId: string; sessionKey: string },
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
		await withFileLock(`conversation-session-transcript:${ctx.userId}:${sessionId}`, async () => {
			const path = `conversation/sessions/${sessionId}.md`;
			const raw = await store.read(path);
			const base = raw === '' ? encodeNew(this.buildFrontmatter(ctx, sessionId)) : raw;
			const next = encodeAppend(encodeAppend(base, userTurn), assistantTurn);
			await store.write(path, next);
		});

		return { sessionId };
	}

	// Must be called while the caller holds the conversation-session-index:<userId> lock.
	private async mintAndRegister(
		store: ReturnType<DataStoreService['forUser']>,
		ctx: { userId: string; sessionKey: string; model?: string; householdId?: string | null },
	): Promise<string> {
		const now = this.now();
		for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
			const id = this.mintId(now);
			const existing = await store.read(`conversation/sessions/${id}.md`);
			if (existing === '') {
				const entry: ActiveSessionEntry = {
					id,
					started_at: now.toISOString(),
					model: ctx.model ?? null,
				};
				await setActiveUnlocked(store, ctx.sessionKey, entry);
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
	): ChatSessionFrontmatter {
		return {
			id: sessionId,
			source: 'telegram',
			user_id: ctx.userId,
			household_id: ctx.householdId ?? null,
			model: ctx.model ?? null,
			title: null,
			parent_session_id: null,
			started_at: this.now().toISOString(),
			ended_at: null,
			token_counts: { input: 0, output: 0 },
		};
	}

	async loadRecentTurns(
		ctx: { userId: string; sessionKey: string },
		opts?: { maxTurns?: number },
	): Promise<SessionTurn[]> {
		const store = this.deps.data.forUser(ctx.userId);
		await this.maybeImportLegacy(store, ctx.userId, null);
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
		_reason: 'newchat' | 'reset' | 'system',
	): Promise<{ endedSessionId: string | null }> {
		const store = this.deps.data.forUser(ctx.userId);
		const entry = await getActive(store, ctx.userId, ctx.sessionKey);
		if (!entry) return { endedSessionId: null };

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
			decoded.meta.ended_at = this.now().toISOString();
			let next = encodeNew(decoded.meta);
			for (const t of decoded.turns) next = encodeAppend(next, t);
			await store.write(path, next);
		});

		await clearActive(store, ctx.userId, ctx.sessionKey);
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
	// Idempotent: short-circuits when any existing session has source: legacy-import.
	private async maybeImportLegacy(
		store: ReturnType<DataStoreService['forUser']>,
		userId: string,
		householdId: string | null,
	): Promise<void> {
		await withFileLock(`legacy-migration:${userId}`, async () => {
			// Sentinel check: scan existing sessions for any legacy-import
			const sessionFiles = await store.list('conversation/sessions/');
			for (const filename of sessionFiles) {
				if (!filename.endsWith('.md')) continue;
				const raw = await store.read(`conversation/sessions/${filename}`);
				try {
					const { meta } = decode(raw);
					if (meta.source === 'legacy-import') return;
				} catch {
					// Corrupt — skip this file
				}
			}

			// Read history.json
			const historyRaw = await store.read('history.json');
			if (!historyRaw) return;

			let legacyTurns: Array<{ role: unknown; content: unknown; timestamp: unknown }>;
			try {
				const parsed = JSON.parse(historyRaw);
				if (!Array.isArray(parsed) || parsed.length === 0) return;
				legacyTurns = parsed as typeof legacyTurns;
			} catch {
				this.deps.logger.warn({ userId }, 'conversation-session: legacy history.json malformed JSON, skipping migration');
				return;
			}

			const isValidIso = (v: unknown): v is string =>
				typeof v === 'string' && !Number.isNaN(Date.parse(v));

			const firstTs = isValidIso(legacyTurns[0]?.timestamp)
				? legacyTurns[0].timestamp
				: this.now().toISOString();
			const lastTs = isValidIso(legacyTurns[legacyTurns.length - 1]?.timestamp)
				? legacyTurns[legacyTurns.length - 1]!.timestamp as string
				: this.now().toISOString();

			const startDate = isValidIso(legacyTurns[0]?.timestamp)
				? new Date(legacyTurns[0].timestamp)
				: this.now();

			// Mint session id with collision retry
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
		});
	}
}
