/** Types for conversation session, idle-reset state, and durable memory snapshot. */

export type IdleResetStatus = 'reset' | 'protected' | 'none';

export interface IdleResetState {
	status: IdleResetStatus;
	endedSessionId?: string;
	parentTitle?: string | null;
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
