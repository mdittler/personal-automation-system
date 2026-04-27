/**
 * Tests for ConversationRetrievalServiceImpl skeleton.
 *
 * Chunk A: verifies construction, method existence, and that every method
 * throws an error. Methods are guarded by requestContext — without a userId
 * they throw MissingRequestContextError; inside a context they throw the
 * "not implemented" stub error.
 */

import { describe, expect, it } from 'vitest';
import { requestContext } from '../../context/request-context.js';
import {
	ConversationRetrievalServiceImpl,
	MissingRequestContextError,
} from '../conversation-retrieval-service.js';

/** Run fn inside a fake requestContext with a stubbed userId. */
function withUserId<T>(userId: string, fn: () => T): T {
	return requestContext.run({ userId }, fn);
}

describe('ConversationRetrievalServiceImpl construction', () => {
	it('constructs successfully with an empty deps object', () => {
		expect(() => new ConversationRetrievalServiceImpl({})).not.toThrow();
	});

	it('constructs successfully with all deps provided (stubs)', () => {
		const stub = {} as never;
		expect(
			() =>
				new ConversationRetrievalServiceImpl({
					dataQuery: stub,
					contextStore: stub,
					interactionContext: stub,
					appMetadata: stub,
					appKnowledge: stub,
					systemInfo: stub,
					logger: stub,
				}),
		).not.toThrow();
	});
});

describe('ConversationRetrievalServiceImpl method existence', () => {
	const service = new ConversationRetrievalServiceImpl({});

	const methods = [
		'searchData',
		'listContextEntries',
		'getRecentInteractions',
		'getEnabledApps',
		'searchAppKnowledge',
		'buildSystemDataBlock',
		'listScopedReports',
		'listScopedAlerts',
		'buildContextSnapshot',
	] as const;

	for (const method of methods) {
		it(`${method} exists and is a function`, () => {
			expect(typeof service[method]).toBe('function');
		});
	}
});

describe('ConversationRetrievalServiceImpl — every method returns a Promise', () => {
	const service = new ConversationRetrievalServiceImpl({});

	it('searchData returns a Promise (rejected)', () => {
		const result = withUserId('user1', () => service.searchData({ question: 'test' }));
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('listContextEntries returns a Promise', () => {
		const result = withUserId('user1', () => service.listContextEntries());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('getRecentInteractions returns a Promise', () => {
		const result = withUserId('user1', () => service.getRecentInteractions());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('getEnabledApps returns a Promise', () => {
		const result = withUserId('user1', () => service.getEnabledApps());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('searchAppKnowledge returns a Promise', () => {
		const result = withUserId('user1', () => service.searchAppKnowledge('test'));
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('buildSystemDataBlock returns a Promise', () => {
		const result = withUserId('user1', () =>
			service.buildSystemDataBlock({ question: 'test', isAdmin: false }),
		);
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('listScopedReports returns a Promise', () => {
		const result = withUserId('user1', () => service.listScopedReports());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('listScopedAlerts returns a Promise', () => {
		const result = withUserId('user1', () => service.listScopedAlerts());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('buildContextSnapshot returns a Promise', () => {
		const result = withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'test',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
				isAdmin: false,
			}),
		);
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});
});

describe('ConversationRetrievalServiceImpl — MissingRequestContextError outside context', () => {
	const service = new ConversationRetrievalServiceImpl({});

	it('searchData throws MissingRequestContextError when no userId in context', async () => {
		// Run in a context without userId
		const result = requestContext.run({}, () => service.searchData({ question: 'test' }));
		await expect(result).rejects.toThrow(MissingRequestContextError);
	});

	it('listContextEntries throws MissingRequestContextError when no userId in context', async () => {
		const result = requestContext.run({}, () => service.listContextEntries());
		await expect(result).rejects.toThrow(MissingRequestContextError);
	});

	it('buildContextSnapshot throws MissingRequestContextError when no userId in context', async () => {
		const result = requestContext.run({}, () =>
			service.buildContextSnapshot({
				question: 'test',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
				isAdmin: false,
			}),
		);
		await expect(result).rejects.toThrow(MissingRequestContextError);
	});
});

describe('ConversationRetrievalServiceImpl — every method throws "not implemented" inside context', () => {
	const service = new ConversationRetrievalServiceImpl({});

	it('searchData throws error with "not implemented" message', async () => {
		await expect(
			withUserId('user1', () => service.searchData({ question: 'test' })),
		).rejects.toThrow(/not implemented/i);
	});

	it('listContextEntries throws error with "not implemented" message', async () => {
		await expect(withUserId('user1', () => service.listContextEntries())).rejects.toThrow(
			/not implemented/i,
		);
	});

	it('getRecentInteractions throws error with "not implemented" message', async () => {
		await expect(withUserId('user1', () => service.getRecentInteractions())).rejects.toThrow(
			/not implemented/i,
		);
	});

	it('getEnabledApps throws error with "not implemented" message', async () => {
		await expect(withUserId('user1', () => service.getEnabledApps())).rejects.toThrow(
			/not implemented/i,
		);
	});

	it('searchAppKnowledge throws error with "not implemented" message', async () => {
		await expect(withUserId('user1', () => service.searchAppKnowledge('test'))).rejects.toThrow(
			/not implemented/i,
		);
	});

	it('buildSystemDataBlock throws error with "not implemented" message', async () => {
		await expect(
			withUserId('user1', () => service.buildSystemDataBlock({ question: 'test', isAdmin: false })),
		).rejects.toThrow(/not implemented/i);
	});

	it('listScopedReports throws error with "not implemented" message (blocked on Chunk B)', async () => {
		await expect(withUserId('user1', () => service.listScopedReports())).rejects.toThrow(
			/not implemented/i,
		);
	});

	it('listScopedAlerts throws error with "not implemented" message (blocked on Chunk B)', async () => {
		await expect(withUserId('user1', () => service.listScopedAlerts())).rejects.toThrow(
			/not implemented/i,
		);
	});

	it('buildContextSnapshot throws error with "not implemented" message', async () => {
		await expect(
			withUserId('user1', () =>
				service.buildContextSnapshot({
					question: 'test',
					mode: 'free-text',
					dataQueryCandidate: false,
					recentFilePaths: [],
					isAdmin: false,
				}),
			),
		).rejects.toThrow(/not implemented/i);
	});
});
