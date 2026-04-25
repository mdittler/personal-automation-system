import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import { ConversationHistory } from '../../conversation-history/index.js';
import { handleMessage } from '../handle-message.js';

function makeHistory() {
	const history = new ConversationHistory({ maxTurns: 20 });
	vi.spyOn(history, 'load').mockResolvedValue([]);
	vi.spyOn(history, 'append').mockResolvedValue(undefined);
	return history;
}

function makeDeps() {
	const services = createMockCoreServices();
	const store = createMockScopedStore();
	vi.mocked(services.data.forUser).mockReturnValue(store);
	vi.mocked(services.llm.complete).mockResolvedValue('The assistant response');
	return {
		services,
		store,
		history: makeHistory(),
	};
}

describe('handleMessage', () => {
	it('sends the LLM response to the user', async () => {
		const { services, history } = makeDeps();
		const ctx = createTestMessageContext({ text: 'Hello bot' });

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			history,
		});

		expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'The assistant response');
	});

	it('saves history after sending the response', async () => {
		const { services, history } = makeDeps();
		const ctx = createTestMessageContext({ text: 'Remember this' });

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			history,
		});

		expect(history.append).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ role: 'user', content: 'Remember this' }),
			expect.objectContaining({ role: 'assistant', content: 'The assistant response' }),
		);
	});

	it('sends a friendly error message when LLM call fails', async () => {
		const { services, history } = makeDeps();
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('rate limit'));
		const ctx = createTestMessageContext({ text: 'hello' });

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			history,
		});

		expect(services.telegram.send).toHaveBeenCalled();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0][1] as string;
		// Should be a user-friendly error message, not a raw stack trace
		expect(sentText).not.toContain('Error:');
		expect(sentText.length).toBeGreaterThan(0);
	});

	it('strips switch-model tags without executing them', async () => {
		const { services, history } = makeDeps();
		vi.mocked(services.llm.complete).mockResolvedValue(
			'Here is my answer <switch-model tier="fast" provider="anthropic" model="claude-haiku-4-5-20251001"/> done.',
		);
		const ctx = createTestMessageContext({ text: 'What model?' });

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			history,
		});

		const sentText = vi.mocked(services.telegram.send).mock.calls[0][1] as string;
		expect(sentText).not.toContain('<switch-model');
		// setTierModel should NOT be called — tags are stripped without executing
		expect(services.systemInfo?.setTierModel).not.toHaveBeenCalled();
	});

	it('logs a warning and continues when history.append fails', async () => {
		const { services, history } = makeDeps();
		vi.spyOn(history, 'append').mockRejectedValue(new Error('disk full'));
		const ctx = createTestMessageContext({ text: 'hello' });

		// Should not throw
		await expect(
			handleMessage(ctx, {
				llm: services.llm,
				telegram: services.telegram,
				data: services.data,
				logger: services.logger,
				timezone: 'UTC',
				history,
			}),
		).resolves.toBeUndefined();

		expect(services.logger.warn).toHaveBeenCalled();
		// Response was still sent before the history failure
		expect(services.telegram.send).toHaveBeenCalled();
	});
});
