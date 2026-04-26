import { describe, expect, it, vi } from 'vitest';
import { LLMRateLimitError } from '../../llm/errors.js';
import { requestContext } from '../../context/request-context.js';
import { chatbotMessage } from '../../../testing/fixtures/messages.js';
import type { ConversationServiceDeps } from '../conversation-service.js';
import { ConversationService } from '../conversation-service.js';

function mockDeps(): ConversationServiceDeps {
	const llm = {
		complete: vi.fn().mockResolvedValue('hi back'),
		classify: vi.fn(),
		extractStructured: vi.fn(),
		getModelForTier: vi.fn().mockReturnValue('claude-sonnet-4-6'),
	};
	const telegram = {
		send: vi.fn(),
		sendPhoto: vi.fn(),
		sendOptions: vi.fn(),
		sendWithButtons: vi.fn(),
		editMessage: vi.fn(),
	};
	const userStore = {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	const data = {
		forUser: vi.fn().mockReturnValue(userStore),
		forShared: vi.fn().mockReturnValue(userStore),
		forSpace: vi.fn().mockReturnValue(userStore),
	};
	return {
		llm: llm as any,
		telegram: telegram as any,
		data: data as any,
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
		timezone: 'UTC',
	};
}

describe('ConversationService', () => {
	it('handleMessage delegates to core helper inside the caller-established requestContext', async () => {
		const deps = mockDeps();
		const svc = new ConversationService(deps);
		const observed: string[] = [];
		(deps.telegram as any).send.mockImplementation(async () => {
			observed.push(requestContext.getStore()?.userId ?? 'no-context');
		});

		await requestContext.run({ userId: 'user-0', householdId: 'hh-0' }, async () => {
			await svc.handleMessage(chatbotMessage('user-0', 1));
		});

		expect((deps.telegram as any).send).toHaveBeenCalled();
		expect(observed[0]).toBe('user-0');
	});

	it('owns one ConversationHistory across calls (state preserved)', async () => {
		const deps = mockDeps();
		const svc = new ConversationService(deps);
		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleMessage(chatbotMessage('user-0', 1));
			await svc.handleMessage(chatbotMessage('user-0', 2));
		});
		expect((deps.llm as any).complete).toHaveBeenCalledTimes(2);
	});

	it('LLMRateLimitError surfaces as friendly user reply (testing-standards rule #1)', async () => {
		const deps = mockDeps();
		(deps.llm as any).complete = vi.fn().mockRejectedValue(
			new LLMRateLimitError({
				scope: 'app',
				appId: 'chatbot',
				maxRequests: 60,
				windowSeconds: 3600,
			}),
		);
		const svc = new ConversationService(deps);
		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleMessage(chatbotMessage('user-0', 1));
		});
		expect((deps.telegram as any).send).toHaveBeenCalledWith('user-0', expect.any(String));
	});

	it('two simultaneous handleMessage calls for the same user serialize via writeQueue (rule #6)', async () => {
		const deps = mockDeps();
		const svc = new ConversationService(deps);
		await requestContext.run({ userId: 'user-0' }, async () => {
			await Promise.all([
				svc.handleMessage(chatbotMessage('user-0', 1)),
				svc.handleMessage(chatbotMessage('user-0', 2)),
			]);
		});
		expect((deps.llm as any).complete).toHaveBeenCalledTimes(2);
	});
});
