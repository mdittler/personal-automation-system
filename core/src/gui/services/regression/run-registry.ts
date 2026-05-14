/**
 * In-memory registry of regression-suite runs.
 *
 * Single-active-run enforcement, ring-buffered event log for SSE reconnect
 * via `Last-Event-ID`, terminal-state inference, idempotent cancel/GC/shutdown.
 * Process-local: restart drops in-flight runs (cached per-case results on
 * disk survive). `getEventsAfter` returns events strictly newer than the
 * client's last id, or `{gap: true}` if the buffer has evicted the next
 * expected id; `attach` replays the buffer then registers for live events,
 * `attachLive` skips the replay so the SSE route can replay-then-attach
 * without double-dispatching on reconnect.
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

export const TERMINAL_EVENT_TYPES = [
	'complete',
	'gate-failed',
	'failed',
	'cancelled',
] as const;

export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

export function isTerminalEventType(t: RegressionEvent['type']): t is TerminalEventType {
	return (TERMINAL_EVENT_TYPES as readonly string[]).includes(t);
}

export type RegistryListener = (event: RegressionEvent, id: number) => void;

export const MAX_EVENT_LOG_ENTRIES = 1000;

export interface RunState {
	runId: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	args: readonly string[];
	eventLog: Array<{ id: number; event: RegressionEvent }>;
	nextEventId: number;
	listeners: Set<RegistryListener>;
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
	/**
	 * Invoked once `createRun()` has minted the runId. The third argument is
	 * the registry-issued runId — required so the subprocess can be tagged
	 * with `--run-id=<runId>` without observing a TDZ-captured outer variable.
	 */
	runFactory: (
		onEvent: (e: RegressionEvent) => void,
		signal: AbortSignal,
		runId: string,
	) => Promise<FakeRunHandleShape | undefined> | FakeRunHandleShape | undefined;
}

export type ReplayResult = Array<{ id: number; event: RegressionEvent }> | { gap: true };

export interface RunRegistry {
	createRun(opts: CreateRunOptions): Promise<{ runId: string }>;
	/** Replays the buffered event log to `listener`, then registers for live events. */
	attach(runId: string, listener: RegistryListener): (() => void) | null;
	/** Registers `listener` for live events WITHOUT replaying the buffer. */
	attachLive(runId: string, listener: RegistryListener): (() => void) | null;
	getEventsAfter(runId: string, lastEventId: number | null): ReplayResult;
	cancel(runId: string): Promise<void>;
	get(runId: string): RunState | undefined;
	isTerminal(runId: string): boolean;
	gc(opts: { maxAgeMs: number }): void;
	shutdown(): Promise<void>;
	waitForCompletion(runId: string): Promise<void>;
	setNow(fn: () => number): void;
	/**
	 * Hook fired after a run reaches a terminal status. Runs after SSE
	 * listeners are dispatched and state is marked terminal. Errors are
	 * swallowed so a misbehaving hook cannot wedge other hooks.
	 */
	onTerminal(hook: (runId: string, status: RunStatus) => void): () => void;
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(TERMINAL_EVENT_TYPES);

export function createRunRegistry(options?: { now?: () => number }): RunRegistry {
	const runs = new Map<string, RunState>();
	const terminalHooks = new Set<(runId: string, status: RunStatus) => void>();
	let activeRunId: string | null = null;
	let now: () => number = options?.now ?? (() => Date.now());

	function dispatchEvent(state: RunState, event: RegressionEvent): void {
		const id = state.nextEventId++;
		state.eventLog.push({ id, event });
		while (state.eventLog.length > MAX_EVENT_LOG_ENTRIES) {
			state.eventLog.shift();
		}
		for (const listener of state.listeners) {
			try {
				listener(event, id);
			} catch {
				/* listener errors do not affect other listeners */
			}
		}
		if (isTerminalEventType(event.type)) {
			const terminal = event.type as TerminalEventType;
			state.status = terminal;
			state.endedAt = now();
			if (activeRunId === state.runId) activeRunId = null;
			// Defer hook invocation so a slow hook body cannot block the
			// synchronous listener loop above.
			const runId = state.runId;
			for (const hook of terminalHooks) {
				queueMicrotask(() => {
					try {
						hook(runId, terminal);
					} catch {
						/* terminal-hook errors do not affect other hooks */
					}
				});
			}
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
				eventLog: [],
				nextEventId: 0,
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

			// If runFactory rejects (e.g. spawnRegression throws on a bad
			// cliPath), clear activeRunId + resolve whenComplete before
			// rethrowing — otherwise subsequent createRun() calls would be
			// rejected forever by a phantom active run.
			let handle: FakeRunHandleShape | undefined;
			try {
				handle = (await runFactory(onEvent, abort.signal, runId)) as FakeRunHandleShape | undefined;
			} catch (err) {
				state.status = 'failed';
				state.endedAt = now();
				if (activeRunId === runId) activeRunId = null;
				resolveComplete();
				throw err;
			}

			if (handle && typeof (handle as FakeRunHandleShape).whenComplete?.then === 'function') {
				(handle as FakeRunHandleShape).whenComplete.then(resolveComplete, resolveComplete);
			} else {
				// No external completion signal — resolve once a terminal event
				// fires. Check the event directly: listeners run before
				// dispatchEvent updates state.status.
				const detach = (e: RegressionEvent): void => {
					if (isTerminalEventType(e.type)) {
						state.listeners.delete(detach);
						resolveComplete();
					}
				};
				state.listeners.add(detach);
			}

			return { runId };
		},

		attach(runId, listener) {
			const state = runs.get(runId);
			if (!state) return null;
			for (const { id, event } of state.eventLog) listener(event, id);
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},

		attachLive(runId, listener) {
			const state = runs.get(runId);
			if (!state) return null;
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},

		getEventsAfter(runId, lastEventId) {
			const state = runs.get(runId);
			if (!state) return [];
			if (lastEventId === null || !Number.isFinite(lastEventId) || lastEventId < 0) {
				return state.eventLog.slice();
			}
			// Gap when the next expected event has been evicted from the ring
			// buffer: the client cannot catch up by appending and needs a reload.
			const first = state.eventLog[0];
			if (first !== undefined && first.id > lastEventId + 1) {
				return { gap: true };
			}
			return state.eventLog.filter((entry) => entry.id > lastEventId);
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

		isTerminal(runId) {
			const state = runs.get(runId);
			return state !== undefined && TERMINAL_STATUSES.has(state.status);
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

		onTerminal(hook) {
			terminalHooks.add(hook);
			return () => {
				terminalHooks.delete(hook);
			};
		},
	};
}
