import { describe, expect, it } from 'vitest';
import { getCurrentUserId, llmContext } from '../llm-context.js';

describe('LLM Context (AsyncLocalStorage)', () => {
	it('returns undefined when no context is set', () => {
		expect(getCurrentUserId()).toBeUndefined();
	});

	it('returns userId within a run scope', async () => {
		let capturedUserId: string | undefined;
		await llmContext.run({ userId: 'user-123' }, () => {
			capturedUserId = getCurrentUserId();
		});
		expect(capturedUserId).toBe('user-123');
	});

	it('returns undefined after run scope exits', async () => {
		await llmContext.run({ userId: 'user-456' }, () => {
			// inside scope
		});
		expect(getCurrentUserId()).toBeUndefined();
	});

	it('handles nested contexts', async () => {
		let outerUserId: string | undefined;
		let innerUserId: string | undefined;

		await llmContext.run({ userId: 'outer' }, async () => {
			outerUserId = getCurrentUserId();
			await llmContext.run({ userId: 'inner' }, () => {
				innerUserId = getCurrentUserId();
			});
			// After inner exits, should still be outer
			expect(getCurrentUserId()).toBe('outer');
		});

		expect(outerUserId).toBe('outer');
		expect(innerUserId).toBe('inner');
	});

	it('propagates through async operations', async () => {
		let asyncUserId: string | undefined;

		await llmContext.run({ userId: 'async-user' }, async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			asyncUserId = getCurrentUserId();
		});

		expect(asyncUserId).toBe('async-user');
	});

	it('returns undefined when context has no userId', async () => {
		let capturedUserId: string | undefined;
		await llmContext.run({}, () => {
			capturedUserId = getCurrentUserId();
		});
		expect(capturedUserId).toBeUndefined();
	});

	it('isolates concurrent contexts', async () => {
		const results: string[] = [];

		await Promise.all([
			llmContext.run({ userId: 'user-a' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				results.push(`a:${getCurrentUserId()}`);
			}),
			llmContext.run({ userId: 'user-b' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				results.push(`b:${getCurrentUserId()}`);
			}),
		]);

		expect(results).toContain('a:user-a');
		expect(results).toContain('b:user-b');
	});
});
