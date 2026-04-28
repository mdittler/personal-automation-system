import { describe, it, expect } from 'vitest';
import { requestContext, getCurrentSessionId } from '../request-context.js';

describe('getCurrentSessionId', () => {
	it('returns undefined outside any context', () => {
		expect(getCurrentSessionId()).toBeUndefined();
	});

	it('returns undefined when context has no sessionId', async () => {
		await requestContext.run({ userId: 'matt', householdId: 'h1' }, async () => {
			expect(getCurrentSessionId()).toBeUndefined();
		});
	});

	it('returns the bound sessionId when set', async () => {
		await requestContext.run({ userId: 'matt', householdId: 'h1', sessionId: 's1' }, async () => {
			expect(getCurrentSessionId()).toBe('s1');
		});
	});

	it('is isolated per async context', async () => {
		await Promise.all([
			requestContext.run({ userId: 'a', sessionId: 'sess-a' }, async () => {
				await new Promise((r) => setTimeout(r, 5));
				expect(getCurrentSessionId()).toBe('sess-a');
			}),
			requestContext.run({ userId: 'b', sessionId: 'sess-b' }, async () => {
				await new Promise((r) => setTimeout(r, 5));
				expect(getCurrentSessionId()).toBe('sess-b');
			}),
		]);
	});
});
