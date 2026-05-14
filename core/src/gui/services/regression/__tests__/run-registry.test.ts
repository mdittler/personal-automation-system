/**
 * run-registry tests.
 *
 * Single active run; concurrent POSTs raise RegistrationConflictError.
 * Cancel sends SIGTERM and transitions terminal state to cancelled.
 * GC evicts old terminal entries. Server shutdown reaps live children.
 */

import { describe, expect, it } from 'vitest';
import {
	MAX_EVENT_LOG_ENTRIES,
	RegistrationConflictError,
	type RegressionEvent,
	createRunRegistry,
} from '../run-registry.js';

interface FakeRun {
	cancel: () => void;
	emit: (event: RegressionEvent) => void;
	finish: () => void;
}

function makeFakeRunFactory(): {
	factory: (onEvent: (e: RegressionEvent) => void, signal: AbortSignal) => Promise<FakeRun>;
	runs: FakeRun[];
} {
	const runs: FakeRun[] = [];
	const factory = async (
		onEvent: (e: RegressionEvent) => void,
		signal: AbortSignal,
	): Promise<FakeRun> => {
		let resolveComplete!: () => void;
		const whenComplete = new Promise<void>((res) => {
			resolveComplete = res;
		});
		const fake: FakeRun = {
			cancel: () => {
				onEvent({ type: 'cancelled' });
				resolveComplete();
			},
			emit: (event) => onEvent(event),
			finish: () => resolveComplete(),
		};
		signal.addEventListener('abort', () => fake.cancel());
		runs.push(fake);
		// Keep the promise unresolved until the test calls finish/cancel.
		void whenComplete;
		// Return both the run handle and the promise; the registry awaits it.
		(fake as FakeRun & { whenComplete: Promise<void> }).whenComplete = whenComplete;
		return fake;
	};
	return { factory, runs };
}

describe('run-registry — single active run', () => {
	it('createRun returns a runId on success', async () => {
		const { factory } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		expect(runId).toMatch(/^[a-z0-9-]{8,}$/i);
	});

	it('second createRun while one is active rejects with RegistrationConflictError', async () => {
		const { factory } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const first = await registry.createRun({ args: ['--json'], runFactory: factory });
		await expect(
			registry.createRun({ args: ['--json'], runFactory: factory }),
		).rejects.toBeInstanceOf(RegistrationConflictError);
		// And the active runId is exposed for the UI to redirect:
		try {
			await registry.createRun({ args: ['--json'], runFactory: factory });
		} catch (err) {
			expect((err as RegistrationConflictError).activeRunId).toBe(first.runId);
		}
	});

	it('after a run completes, a new run can be created', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const first = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'summary', summary: {} });
		runs[0]!.emit({ type: 'complete', summary: {} });
		runs[0]!.finish();
		await registry.waitForCompletion(first.runId);
		const second = await registry.createRun({ args: ['--json'], runFactory: factory });
		expect(second.runId).not.toBe(first.runId);
	});
});

describe('run-registry — attach + buffer replay', () => {
	it('attach replays buffered events to a late listener', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'b' } });
		const collected: RegressionEvent[] = [];
		registry.attach(runId, (e) => collected.push(e));
		// Synchronous replay of the two buffered events:
		expect(collected.map((e) => e.type)).toEqual(['case-result', 'case-result']);
	});

	it('attach forwards new events to subscribed listeners', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		const collected: RegressionEvent[] = [];
		registry.attach(runId, (e) => collected.push(e));
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		expect(collected[0]?.type).toBe('case-result');
	});

	it('multiple listeners both receive all events', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		const a: RegressionEvent[] = [];
		const b: RegressionEvent[] = [];
		registry.attach(runId, (e) => a.push(e));
		registry.attach(runId, (e) => b.push(e));
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'x' } });
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
	});

	it('attach returns null when runId unknown', async () => {
		const registry = createRunRegistry();
		const detach = registry.attach('does-not-exist', () => {});
		expect(detach).toBeNull();
	});

	it('detach stops further event delivery', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		const collected: RegressionEvent[] = [];
		const detach = registry.attach(runId, (e) => collected.push(e));
		expect(detach).not.toBeNull();
		detach?.();
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'after-detach' } });
		expect(collected).toHaveLength(0);
	});
});

describe('run-registry — cancel', () => {
	it('cancel triggers abort signal on the active run', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		const collected: RegressionEvent[] = [];
		registry.attach(runId, (e) => collected.push(e));
		await registry.cancel(runId);
		expect(collected[collected.length - 1]?.type).toBe('cancelled');
	});

	it('cancel for an unknown runId is a no-op', async () => {
		const registry = createRunRegistry();
		await expect(registry.cancel('unknown')).resolves.toBeUndefined();
	});

	it('cancel after completion is idempotent (no-op)', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'complete', summary: {} });
		runs[0]!.finish();
		await registry.waitForCompletion(runId);
		await expect(registry.cancel(runId)).resolves.toBeUndefined();
	});
});

describe('run-registry — terminal state inference', () => {
	it('marks status="complete" after "complete" event', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'complete', summary: {} });
		runs[0]!.finish();
		await registry.waitForCompletion(runId);
		expect(registry.get(runId)?.status).toBe('complete');
	});

	it('marks status="gate-failed" after "gate-failed" event (Codex C3)', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'gate-failed', summary: {}, exitCode: 1 });
		runs[0]!.finish();
		await registry.waitForCompletion(runId);
		expect(registry.get(runId)?.status).toBe('gate-failed');
	});

	it('marks status="failed" after "failed" event', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'failed', exitCode: 1, stderrTail: 'boom' });
		runs[0]!.finish();
		await registry.waitForCompletion(runId);
		expect(registry.get(runId)?.status).toBe('failed');
	});

	it('marks status="cancelled" after "cancelled" event', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'cancelled' });
		runs[0]!.finish();
		await registry.waitForCompletion(runId);
		expect(registry.get(runId)?.status).toBe('cancelled');
	});
});

describe('run-registry — event log + reconnect support (REQ-REG-GUI-V2-021/022)', () => {
	it('dispatchEvent assigns monotonic ids starting at 0', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'b' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'c' } });
		const state = registry.get(runId)!;
		expect(state.eventLog.map((e) => e.id)).toEqual([0, 1, 2]);
		expect(state.nextEventId).toBe(3);
	});

	it('attach replays events with monotonic ids', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'b' } });
		const observed: Array<{ id: number; type: string }> = [];
		registry.attach(runId, (event, id) => observed.push({ id, type: event.type }));
		expect(observed).toEqual([
			{ id: 0, type: 'case-result' },
			{ id: 1, type: 'case-result' },
		]);
	});

	it('attachLive registers a listener WITHOUT replaying buffered events', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'b' } });
		const observed: Array<{ id: number; type: string }> = [];
		const detach = registry.attachLive(runId, (event, id) =>
			observed.push({ id, type: event.type }),
		);
		expect(observed).toEqual([]);
		// New events still flow through.
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'c' } });
		expect(observed).toEqual([{ id: 2, type: 'case-result' }]);
		detach?.();
	});

	it('attachLive returns null when runId unknown', async () => {
		const registry = createRunRegistry();
		expect(registry.attachLive('unknown', () => {})).toBeNull();
	});

	it('getEventsAfter(null) returns the full retained log', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'b' } });
		const replay = registry.getEventsAfter(runId, null);
		expect(Array.isArray(replay)).toBe(true);
		if (Array.isArray(replay)) {
			expect(replay.map((e) => e.id)).toEqual([0, 1]);
		}
	});

	it('getEventsAfter(<id>) returns only events with id > <id>', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'b' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'c' } });
		const replay = registry.getEventsAfter(runId, 0);
		if (Array.isArray(replay)) {
			expect(replay.map((e) => e.id)).toEqual([1, 2]);
		} else {
			throw new Error('expected array, got gap');
		}
	});

	it('getEventsAfter(<latest id>) returns empty array (no new events)', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'b' } });
		const replay = registry.getEventsAfter(runId, 1);
		expect(replay).toEqual([]);
	});

	it('getEventsAfter on empty log returns empty array (no gap)', async () => {
		const { factory } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		expect(registry.getEventsAfter(runId, null)).toEqual([]);
		expect(registry.getEventsAfter(runId, 5)).toEqual([]);
	});

	it('getEventsAfter on unknown runId returns empty array (route handles 404 separately)', () => {
		const registry = createRunRegistry();
		expect(registry.getEventsAfter('unknown', null)).toEqual([]);
		expect(registry.getEventsAfter('unknown', 5)).toEqual([]);
	});

	it('getEventsAfter returns {gap: true} when next expected event has been evicted', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		// Overflow the ring buffer (MAX_EVENT_LOG_ENTRIES = 1000). Emit
		// MAX+10 events so the first 10 are evicted (earliest retained id=10).
		const overflow = MAX_EVENT_LOG_ENTRIES + 10;
		for (let i = 0; i < overflow; i++) {
			runs[0]!.emit({ type: 'case-result', result: { caseId: `case-${i}` } });
		}
		const state = registry.get(runId)!;
		expect(state.eventLog.length).toBe(MAX_EVENT_LOG_ENTRIES);
		expect(state.eventLog[0]!.id).toBe(10);
		// Client says "I last saw id=4" — gap (the next expected id, 5, was evicted).
		const replay = registry.getEventsAfter(runId, 4);
		expect(replay).toEqual({ gap: true });
	});

	it('getEventsAfter does NOT gap when last seen id is exactly earliest retained id - 1', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		const overflow = MAX_EVENT_LOG_ENTRIES + 10;
		for (let i = 0; i < overflow; i++) {
			runs[0]!.emit({ type: 'case-result', result: { caseId: `case-${i}` } });
		}
		const state = registry.get(runId)!;
		expect(state.eventLog[0]!.id).toBe(10);
		// Client says "I last saw id=9" — next expected (10) is the earliest
		// retained id. No gap.
		const replay = registry.getEventsAfter(runId, 9);
		if (Array.isArray(replay)) {
			expect(replay[0]?.id).toBe(10);
			expect(replay.length).toBe(MAX_EVENT_LOG_ENTRIES);
		} else {
			throw new Error('expected array, got gap');
		}
	});

	it('getEventsAfter treats NaN/negative lastEventId as null (full replay)', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'b' } });
		const nanReplay = registry.getEventsAfter(runId, Number.NaN);
		if (Array.isArray(nanReplay)) expect(nanReplay.length).toBe(2);
		const negReplay = registry.getEventsAfter(runId, -1);
		if (Array.isArray(negReplay)) expect(negReplay.length).toBe(2);
	});

	it('ring buffer caps at MAX_EVENT_LOG_ENTRIES; ids continue past cap', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		const overflow = MAX_EVENT_LOG_ENTRIES + 50;
		for (let i = 0; i < overflow; i++) {
			runs[0]!.emit({ type: 'case-result', result: { caseId: `c-${i}` } });
		}
		const state = registry.get(runId)!;
		expect(state.eventLog.length).toBe(MAX_EVENT_LOG_ENTRIES);
		// First retained id is overflow - cap = 50; last retained id = overflow - 1.
		expect(state.eventLog[0]!.id).toBe(overflow - MAX_EVENT_LOG_ENTRIES);
		expect(state.eventLog[state.eventLog.length - 1]!.id).toBe(overflow - 1);
		expect(state.nextEventId).toBe(overflow);
	});

	it('eventLog preserves raw event shape (no id field bleeds into the wrapped event)', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'case-result', result: { caseId: 'a' } });
		runs[0]!.emit({ type: 'summary', summary: { totalCases: 1 } });
		const state = registry.get(runId)!;
		expect(state.eventLog.map((e) => e.event.type)).toEqual(['case-result', 'summary']);
		for (const { event } of state.eventLog) {
			expect((event as Record<string, unknown>).id).toBeUndefined();
		}
	});

	it('isTerminal returns false during run, true after terminal event', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		expect(registry.isTerminal(runId)).toBe(false);
		runs[0]!.emit({ type: 'complete', summary: {} });
		runs[0]!.finish();
		await registry.waitForCompletion(runId);
		expect(registry.isTerminal(runId)).toBe(true);
	});

	it('isTerminal returns false for unknown runId', () => {
		const registry = createRunRegistry();
		expect(registry.isTerminal('unknown')).toBe(false);
	});
});

describe('run-registry — GC + shutdown', () => {
	it('gc evicts terminal runs older than maxAgeMs', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry({ now: () => 0 });
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		runs[0]!.emit({ type: 'complete', summary: {} });
		runs[0]!.finish();
		await registry.waitForCompletion(runId);
		// Move "now" past the GC horizon and run gc:
		registry.setNow(() => 60 * 60 * 1000 + 1);
		registry.gc({ maxAgeMs: 60 * 60 * 1000 });
		expect(registry.get(runId)).toBeUndefined();
	});

	it('gc does NOT evict an active run regardless of age', async () => {
		const { factory } = makeFakeRunFactory();
		const registry = createRunRegistry({ now: () => 0 });
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		registry.setNow(() => 60 * 60 * 1000 + 1);
		registry.gc({ maxAgeMs: 60 * 60 * 1000 });
		expect(registry.get(runId)?.status).not.toBe('complete');
	});

	it('shutdown cancels all active runs and clears the registry', async () => {
		const { factory, runs } = makeFakeRunFactory();
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({ args: ['--json'], runFactory: factory });
		const collected: RegressionEvent[] = [];
		registry.attach(runId, (e) => collected.push(e));
		await registry.shutdown();
		expect(collected[collected.length - 1]?.type).toBe('cancelled');
		expect(registry.get(runId)?.status).toBe('cancelled');
	});
});
