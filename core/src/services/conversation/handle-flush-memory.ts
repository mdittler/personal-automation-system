/**
 * handleFlushMemory — `/flushmemory` Router built-in.
 *
 * Immediately summarizes the active session and writes the result to
 * ContextStore under `recent-session-summary`, regardless of the
 * `flush_memory_on_idle_reset` toggle.
 *
 * REQ-CONV-FLUSH-013..018.
 */

import type { AppLogger } from '../../types/app-module.js';
import type { MessageContext, TelegramService } from '../../types/telegram.js';
import { escapeMarkdown } from '../../utils/escape-markdown.js';
import type { ChatSessionStore, SessionTurn } from '../conversation-session/chat-session-store.js';
import { resolveOrDefaultSessionKey } from '../conversation-session/session-key.js';
import { type MemoryFlushSave, flushMemoryToContextStore } from './memory-flush.js';

export interface HandleFlushMemoryDeps {
	telegram: TelegramService;
	chatSessions: ChatSessionStore;
	summarizer: (turns: SessionTurn[], signal?: AbortSignal) => Promise<string | null>;
	flushSave: MemoryFlushSave;
	logger: AppLogger;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export async function handleFlushMemory(
	_args: string,
	ctx: MessageContext,
	deps: HandleFlushMemoryDeps,
): Promise<void> {
	const userId = ctx.userId;
	const sessionKey = resolveOrDefaultSessionKey(ctx);
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// 1. Find the active session
	let activeId: string | undefined;
	try {
		activeId = await deps.chatSessions.peekActive({ userId, sessionKey });
	} catch (err) {
		deps.logger.warn(`flush-memory: peekActive failed userId=${userId}: ${String(err)}`);
		await deps.telegram.send(userId, escapeMarkdown('Memory flush deferred — try again later.'));
		return;
	}
	if (!activeId) {
		await deps.telegram.send(userId, escapeMarkdown('No active session — start chatting first.'));
		return;
	}

	// 2. Read the session turns
	let session: { turns: SessionTurn[] } | undefined;
	try {
		session = await deps.chatSessions.readSession(userId, activeId);
	} catch (err) {
		deps.logger.warn(`flush-memory: readSession failed userId=${userId}: ${String(err)}`);
		await deps.telegram.send(userId, escapeMarkdown('Memory flush deferred — try again later.'));
		return;
	}
	if (!session || session.turns.length < 2) {
		await deps.telegram.send(userId, escapeMarkdown('Not enough conversation to summarize yet.'));
		return;
	}

	// 3. Summarize with timeout + late-resolve guard
	const controller = new AbortController();
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const timeoutPromise = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
			resolve('timeout');
		}, timeoutMs);
		timer.unref?.();
	});

	type WorkResult =
		| { status: 'written'; persistedLength: number }
		| { status: 'failed' }
		| { status: 'skipped' };

	const work: Promise<WorkResult | 'timeout'> = (async (): Promise<WorkResult> => {
		let summary: string | null;
		try {
			summary = await deps.summarizer(session!.turns, controller.signal);
		} catch (err) {
			deps.logger.warn(`flush-memory: summarizer threw userId=${userId}: ${String(err)}`);
			return { status: 'failed' };
		}

		// Late-resolve guard: summarizer may have resolved after the timeout fired.
		if (timedOut || controller.signal.aborted) return { status: 'failed' };

		if (summary === null) return { status: 'skipped' };

		return flushMemoryToContextStore(userId, summary, {
			flushSave: deps.flushSave,
			logger: deps.logger,
		});
	})();

	let outcome: WorkResult | 'timeout';
	try {
		outcome = await Promise.race([work, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}

	let reply: string;
	if (outcome === 'timeout') {
		reply = 'Memory flush deferred — try again later.';
	} else if (outcome.status === 'written') {
		reply = `Memory flushed: ${outcome.persistedLength} chars saved.`;
	} else if (outcome.status === 'skipped') {
		reply = 'Not enough conversation to summarize yet.';
	} else {
		reply = 'Memory flush deferred — try again later.';
	}

	await deps.telegram.send(userId, escapeMarkdown(reply));
}
