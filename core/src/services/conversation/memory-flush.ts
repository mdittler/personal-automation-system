import { sanitizeSummaryOutput } from './session-summarizer.js';

export const RECENT_SESSION_SUMMARY_KEY = 'recent-session-summary';

/** Pre-bound saver — captures CONTEXT_INTERNAL_BYPASS in compose-runtime. */
export type MemoryFlushSave = (userId: string, key: string, content: string) => Promise<void>;
/** Pre-bound remover — same capability binding. */
export type MemoryFlushRemove = (userId: string, key: string) => Promise<void>;

export interface MemoryFlushDeps {
	flushSave: MemoryFlushSave;
	logger: { warn(obj: unknown, msg?: string): void };
}

export interface MemoryFlushDisableDeps {
	flushRemove: MemoryFlushRemove;
	logger: { warn(obj: unknown, msg?: string): void };
}

export type MemoryFlushResult =
	| { status: 'written'; persistedLength: number }
	| { status: 'failed' };

export async function flushMemoryToContextStore(
	userId: string,
	summary: string,
	deps: MemoryFlushDeps,
): Promise<MemoryFlushResult> {
	// Defense-in-depth: re-sanitize regardless of caller — guarantees safe prompt content
	// even if a future caller bypasses session-summarizer.
	const cleaned = sanitizeSummaryOutput(summary)?.trim() ?? '';
	if (!cleaned) return { status: 'failed' };

	try {
		await deps.flushSave(userId, RECENT_SESSION_SUMMARY_KEY, cleaned);
		return { status: 'written', persistedLength: cleaned.length };
	} catch (err) {
		deps.logger.warn({ err, userId }, 'memory-flush: ContextStore.save failed');
		return { status: 'failed' };
	}
}

export async function disableFlushAndCleanup(
	userId: string,
	deps: MemoryFlushDisableDeps,
): Promise<void> {
	try {
		await deps.flushRemove(userId, RECENT_SESSION_SUMMARY_KEY);
	} catch (err) {
		deps.logger.warn({ err, userId }, 'memory-flush: cleanup remove failed');
	}
}
