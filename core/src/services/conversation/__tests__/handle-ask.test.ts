import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import { ConversationHistory } from '../../conversation-history/index.js';
import { handleAsk } from '../handle-ask.js';

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
	vi.mocked(services.llm.complete).mockResolvedValue('PAS answer');
	return {
		services,
		store,
		history: makeHistory(),
	};
}

describe('handleAsk', () => {
	it('sends a static intro and skips LLM when args is empty', async () => {
		const { services, history } = makeDeps();
		const ctx = createTestMessageContext({ text: '/ask' });

		await handleAsk([], ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			history,
		});

		expect(services.llm.complete).not.toHaveBeenCalled();
		expect(services.telegram.send).toHaveBeenCalledWith(
			'test-user',
			expect.stringContaining('PAS assistant'),
		);
	});

	it('calls LLM at standard tier and sends response for a non-empty question', async () => {
		const { services, history } = makeDeps();
		// classifyPASMessage internally calls llm.complete for the classifier
		// and then handle-ask calls it again for the main answer.
		// Use mockResolvedValueOnce to provide classifier JSON first, then the real answer.
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('{"pasRelated":false,"dataQueryCandidate":false}')
			.mockResolvedValueOnce('Detailed PAS answer');

		const ctx = createTestMessageContext({ text: '/ask what apps do I have?' });

		await handleAsk(['what', 'apps', 'do', 'I', 'have?'], ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			history,
		});

		expect(services.llm.complete).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ tier: 'standard' }),
		);
		expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'Detailed PAS answer');
	});

	it('sends a friendly error message when LLM call fails', async () => {
		const { services, history } = makeDeps();
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('timeout'));
		const ctx = createTestMessageContext({ text: '/ask what?' });

		await handleAsk(['what?'], ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			history,
		});

		expect(services.telegram.send).toHaveBeenCalled();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0][1] as string;
		expect(sentText.length).toBeGreaterThan(0);
	});

	it('saves history with /ask prefix on the user turn', async () => {
		const { services, history } = makeDeps();
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('{"pasRelated":false,"dataQueryCandidate":false}')
			.mockResolvedValueOnce('answer');

		const ctx = createTestMessageContext({ text: '/ask what is the status?' });

		await handleAsk(['what', 'is', 'the', 'status?'], ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			history,
		});

		expect(history.append).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ content: '/ask what is the status?' }),
			expect.objectContaining({ role: 'assistant' }),
		);
	});

	it('processes model-switch tags for an admin user with switch intent', async () => {
		const { services, history } = makeDeps();
		vi.mocked(services.systemInfo!.isUserAdmin).mockReturnValue(true);
		vi.mocked(services.systemInfo!.setTierModel).mockResolvedValue({ success: true });
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('{"pasRelated":false,"dataQueryCandidate":false}')
			.mockResolvedValueOnce(
				'Switching now <switch-model tier="fast" provider="anthropic" model="claude-haiku-4-5-20251001"/>',
			);

		const ctx = createTestMessageContext({
			userId: 'admin',
			text: '/ask switch fast model to claude-haiku',
		});

		await handleAsk(['switch', 'fast', 'model', 'to', 'claude-haiku'], ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			history,
			systemInfo: services.systemInfo,
		});

		expect(services.systemInfo?.setTierModel).toHaveBeenCalledWith(
			'fast',
			'anthropic',
			'claude-haiku-4-5-20251001',
		);
		const sentText = vi.mocked(services.telegram.send).mock.calls[0][1] as string;
		expect(sentText).not.toContain('<switch-model');
		expect(sentText).toContain('✅');
	});
});
