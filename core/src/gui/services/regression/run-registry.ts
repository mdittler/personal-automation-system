/**
 * In-memory registry of regression-suite runs.
 *
 * - Single-active-run enforcement: a second `createRun()` while one is
 *   alive throws `RegistrationConflictError` exposing the active runId
 *   so the GUI can redirect to the live SSE stream instead of erroring.
 * - Per-run event buffer: new SSE clients attaching mid-run replay the
 *   full event sequence (orchestrator is sequential — replay order
 *   matches dispatch order).
 * - Terminal-state inference (Codex C3): `status` transitions from
 *   `running` → `complete | gate-failed | failed | cancelled` based on
 *   the final emitted event.
 * - Idempotent cancel + GC + shutdown.
 *
 * The registry is process-local; restart drops in-flight runs (logged
 * as accepted risk in docs/open-items.md). Cached per-case results
 * survive on disk per REQ-REG-010.
 */

import { randomUUID } from 'node:crypto';

export type RegressionEvent =
	| { type: 'case-result'; result: unknown }
	| { type: 'summary'; summary: unknown }
	| { type: 'complete'; summary: unknown }
	| { type: 'gate-failed'; summary: unknown; exitCode: number }
	| { type: 'failed'; exitCode: number; stderrTail: string }
	| { type: 'cancelled' };

export type RunStatus =
	| 'starting'
	| 'running'
	| 'cancelling'
	| 'complete'
	| 'gate-failed'
	| 'failed'
	| 'cancelled';

export interface RunState {
	runId: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	args: readonly string[];
	events: RegressionEvent[];
	listeners: Set<(e: RegressionEvent) => void>;
	abort: AbortController;
	whenComplete: Promise<void>;
}

export class RegistrationConflictError extends Error {
	constructor(public readonly activeRunId: string) {
		super(`a regression run is already active (runId=${activeRunId})`);
		this.name = 'RegistrationConflictError';
	}
}

interface FakeRunHandleShape {
	whenComplete: Promise<void>;
}

export interface CreateRunOptions {
	args: readonly string[];
	runFactory: (
		onEvent: (e: RegressionEvent) => void,
		signal: AbortSignal,
	) => Promise<FakeRunHandleShape | undefined> | FakeRunHandleShape | undefined;
}

export interface RunRegistry {
	createRun(opts: CreateRunOptions): Promise<{ runId: string }>;
	attach(runId: string, listener: (e: RegressionEvent) => void): (() => void) | null;
	cancel(runId: string): Promise<void>;
	get(runId: string): RunState | undefined;
	gc(opts: { maxAgeMs: number }): void;
	shutdown(): Promise<void>;
	waitForCompletion(runId: string): Promise<void>;
	setNow(fn: () => number): void;
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
	'complete',
	'gate-failed',
	'failed',
	'cancelled',
]);

function inferTerminal(event: RegressionEvent): RunStatus | null {
	switch (event.type) {
		case 'complete':
			return 'complete';
		case 'gate-failed':
			return 'gate-failed';
		case 'failed':
			return 'failed';
		case 'cancelled':
			return 'cancelled';
		default:
			return null;
	}
}

export function createRunRegistry(options?: { now?: () => number }): RunRegistry {
	const runs = new Map<string, RunState>();
	let activeRunId: string | null = null;
	let now: () => number = options?.now ?? (() => Date.now());

	function dispatchEvent(state: RunState, event: RegressionEvent): void {
		state.events.push(event);
		for (const listener of state.listeners) {
			try {
				listener(event);
			} catch {
				/* listener errors do not affect other listeners */
			}
		}
		const terminal = inferTerminal(event);
		if (terminal) {
			state.status = terminal;
			state.endedAt = now();
			if (activeRunId === state.runId) activeRunId = null;
		}
	}

	return {
		async createRun({ args, runFactory }) {
			if (activeRunId) throw new RegistrationConflictError(activeRunId);
			const runId = randomUUID();
			const abort = new AbortController();
			let resolveComplete!: () => void;
			const whenComplete = new Promise<void>((res) => {
				resolveComplete = res;
			});
			const state: RunState = {
				runId,
				status: 'starting',
				startedAt: now(),
				args,
				events: [],
				listeners: new Set(),
				abort,
				whenComplete,
			};
			runs.set(runId, state);
			activeRunId = runId;

			const onEvent = (event: RegressionEvent): void => {
				if (state.status === 'starting') state.status = 'running';
				dispatchEvent(state, event);
			};

			const handle = (await runFactory(onEvent, abort.signal)) as FakeRunHandleShape | undefined;
			if (handle && typeof (handle as FakeRunHandleShape).whenComplete?.then === 'function') {
				(handle as FakeRunHandleShape).whenComplete.then(resolveComplete, resolveComplete);
			} else {
				// No external completion signal — resolve once a terminal event fires.
				const checkDone = (): void => {
					if (TERMINAL_STATUSES.has(state.status)) resolveComplete();
				};
				const detach = (e: RegressionEvent): void => {
					if (inferTerminal(e)) {
						state.listeners.delete(detach);
						checkDone();
					}
				};
				state.listeners.add(detach);
			}

			return { runId };
		},

		attach(runId, listener) {
			const state = runs.get(runId);
			if (!state) return null;
			for (const event of state.events) listener(event);
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},

		async cancel(runId) {
			const state = runs.get(runId);
			if (!state) return;
			if (TERMINAL_STATUSES.has(state.status)) return;
			state.status = 'cancelling';
			state.abort.abort();
			await state.whenComplete;
		},

		get(runId) {
			return runs.get(runId);
		},

		gc({ maxAgeMs }) {
			const cutoff = now() - maxAgeMs;
			for (const [runId, state] of runs) {
				if (!TERMINAL_STATUSES.has(state.status)) continue;
				if (state.endedAt !== undefined && state.endedAt <= cutoff) {
					runs.delete(runId);
				}
			}
		},

		async shutdown() {
			const promises: Array<Promise<void>> = [];
			for (const state of runs.values()) {
				if (!TERMINAL_STATUSES.has(state.status)) {
					state.abort.abort();
					promises.push(state.whenComplete);
				}
			}
			await Promise.all(promises);
		},

		async waitForCompletion(runId) {
			const state = runs.get(runId);
			if (!state) return;
			await state.whenComplete;
		},

		setNow(fn) {
			now = fn;
		},
	};
}
