/** Types for conversation session, idle-reset state, and durable memory snapshot. */

export type IdleResetStatus = 'reset' | 'protected' | 'none';

export interface IdleResetState {
	status: IdleResetStatus;
	/** P8c: id of the session ended by this idle reset. Forwarded by handlers as parentSessionId on the next mint. */
	endedSessionId?: string;
	/** P8a: title of the ended session. Surfaced in the inactivity notice text. */
	parentTitle?: string | null;
	/** P8b: outcome of the memory-flush sub-step. Absent on 'protected'/'none'. */
	summaryStatus?: 'written' | 'skipped' | 'failed' | 'disabled' | 'timeout';
}

/** A frozen snapshot of durable ContextStore entries, built at session-mint time. */
export interface MemorySnapshot {
	/** Rendered entries (key headings + content), alphabetically sorted, budget-truncated. */
	content: string;
	/** ok: successfully built; empty: no entries; degraded: build failed (fail-open). */
	status: 'ok' | 'empty' | 'degraded';
	/** ISO 8601 UTC timestamp of when the snapshot was built. */
	builtAt: string;
	/** Number of ContextStore entries included before any truncation. */
	entryCount: number;
}

/** On-disk YAML shape of the memory_snapshot frontmatter field (snake_case). */
export interface MemorySnapshotFrontmatter {
	content: string;
	status: 'ok' | 'empty' | 'degraded';
	built_at: string;
	entry_count: number;
}
