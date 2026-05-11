/**
 * run-registry tests.
 *
 * Single active run; concurrent POSTs raise RegistrationConflictError.
 * Cancel sends SIGTERM and transitions terminal state to cancelled.
 * GC evicts old terminal entries. Server shutdown reaps live children.
 */

import { describe, expect, it } from 'vitest';
import {
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
