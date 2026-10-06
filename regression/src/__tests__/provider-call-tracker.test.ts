import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_DRAIN_TIMEOUT_MS,
	DEFAULT_SETTLE_MS,
	createProviderCallTracker,
} from '../runner/provider-call-tracker.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('provider-call tracker (REQ-REG-AGENT-002; review C12/C19)', () => {
	it('pins the production settle window and drain timeout (review C27)', () => {
		expect(DEFAULT_SETTLE_MS).toBe(250);
		expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(120_000);
	});

	it('track(): an error is recorded with its label and rethrown; success passes through untouched', async () => {
		const t = createProviderCallTracker({ settleMs: 5, drainTimeoutMs: 100 });
		await expect(
			t.track('ollama', async () => {
				throw new Error('connect ECONNREFUSED');
			}),
		).rejects.toThrow(/ECONNREFUSED/);
		await expect(t.track('ollama', async () => 'ok')).resolves.toBe('ok');
		expect(t.errors).toEqual(['ollama: connect ECONNREFUSED']);
		expect(t.inFlight()).toBe(0);
	});

	it('wrap(): replaces completeWithUsage with a tracked version keyed by providerId', async () => {
		const t = createProviderCallTracker({ settleMs: 5, drainTimeoutMs: 100 });
		const provider = {
			providerId: 'anthropic',
			completeWithUsage: vi.fn(async (_prompt: string, _options?: unknown) => {
				throw new Error('529 overloaded');
			}),
		};
		t.wrap(provider as never);
		await expect(provider.completeWithUsage('p', undefined)).rejects.toThrow(/529/);
		expect(t.errors).toEqual(['anthropic: 529 overloaded']);
	});

	it('drain(): waits through a follow-up call scheduled after the first completes', async () => {
		const t = createProviderCallTracker({ settleMs: 10, drainTimeoutMs: 1000 });
		let secondDone = false;
		void t
			.track('p', () => sleep(5))
			.then(() => {
				// Mirrors Food's shadow classifier: a repair call starts only after the first returns.
				void t
					.track('p', () => sleep(30))
					.then(() => {
						secondDone = true;
					});
			});
		await t.drain();
		expect(secondDone).toBe(true);
		expect(t.inFlight()).toBe(0);
		expect(t.errors).toEqual([]);
	});

	it('drain(): a call that never settles is recorded as an infrastructure error at the timeout', async () => {
		const t = createProviderCallTracker({ settleMs: 5, drainTimeoutMs: 50 });
		void t.track('p', () => new Promise(() => {}));
		const started = Date.now();
		await t.drain();
		expect(Date.now() - started).toBeLessThan(500);
		expect(t.errors).toEqual(['drain: 1 provider call(s) still in flight after 50 ms']);
	});
});
