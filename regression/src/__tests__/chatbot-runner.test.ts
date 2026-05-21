import type { PersonaCase, TierModelSnapshot } from '@core/types/regression.js';
import { describe, expect, it, vi } from 'vitest';
import { runChatbotCase } from '../runner/case-runners/chatbot-runner.js';
import { VERDICT } from '../shared/types.js';
import { StubLLMService } from './_stub-provider.js';

const modelIds: TierModelSnapshot = { fast: 'fast-m', standard: 'std-m', reasoning: null };
const noopLogger = {
	warn: () => {},
	info: () => {},
	debug: () => {},
	error: () => {},
};

function fakeEnv(replyText: string, handlerId: string | null = 'free-text-receipt-query') {
	const sent: Array<{ userId: string; text: string }> = [];
	let recorded: string | null = null;
	const sessionEnds: number[] = [];
	return {
		userId: 'regression-user-0',
		householdId: 'regression-hh-0',
		telegram: {
			sent,
			pushReply: (t: string) => sent.push({ userId: 'regression-user-0', text: t }),
		},
		routeMessage: vi.fn(async () => {
			recorded = handlerId;
			sent.push({ userId: 'regression-user-0', text: replyText });
		}),
		captureHandler: () => () => recorded,
		endActiveSession: vi.fn(async () => {
			sessionEnds.push(Date.now());
			recorded = null;
		}),
		__sessionEnds: sessionEnds,
	};
}

function chatbotCase(overrides: Partial<PersonaCase> = {}): PersonaCase {
	return {
		id: 'cb-test',
		description: 'test',
		bucket: 'chatbot',
		coverage: ['core/src/services/conversation/handle-message.ts'],
		inputs: [{ payload: 'How much did I spend at Costco?', expected: {} }],
		oracle: 'rubric',
		rubric: 'Reply must mention Costco and $306.',
		budgetUsd: 0.2,
		...overrides,
	};
}

describe('runChatbotCase', () => {
	it('routes each input through the environment and grades with rubric oracle', async () => {
		const env = fakeEnv('You spent $306.77 at Costco on 2026-05-01.');
		const judge = new StubLLMService().queue(
			'{"score": 5, "explanation": "mentions Costco and 306"}',
		);
		let cost = 0;
		const tracker = { getMonthlyTotalCost: () => cost };
		// Simulate the runtime LLM calls accruing cost
		env.routeMessage = vi.fn(async () => {
			cost = 0.05;
			env.telegram.pushReply('You spent $306.77 at Costco on 2026-05-01.');
		});
		// Rubric judge call adds more
		const originalComplete = judge.complete.bind(judge);
		judge.complete = async (p, o) => {
			cost = 0.07;
			return originalComplete(p, o);
		};

		const r = await runChatbotCase(chatbotCase(), {
			env,
			judgeLlm: judge,
			judgeModelId: 'std-m',
			costTracker: tracker,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.2,
			estimateUsd: () => 0.001,
			logger: noopLogger,
		});

		expect(r.verdict).toBe(VERDICT.pass);
		expect(r.costUsd).toBeCloseTo(0.07, 4);
		expect(env.routeMessage).toHaveBeenCalledTimes(1);
	});

	it('fails when the rubric judge returns score < 4', async () => {
		const env = fakeEnv('I do not know.');
		const judge = new StubLLMService().queue(
			'{"score": 2, "explanation": "missing required content"}',
		);
		const tracker = { getMonthlyTotalCost: () => 0 };
		const r = await runChatbotCase(chatbotCase(), {
			env,
			judgeLlm: judge,
			judgeModelId: 'std-m',
			costTracker: tracker,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.2,
			estimateUsd: () => 0.001,
			logger: noopLogger,
		});
		expect(r.verdict).toBe(VERDICT.fail);
	});

	it('errors when the rubric judge returns a non-finite score', async () => {
		const env = fakeEnv('whatever');
		const judge = new StubLLMService().queue('{"score": null, "explanation": "x"}');
		const tracker = { getMonthlyTotalCost: () => 0 };
		const r = await runChatbotCase(chatbotCase(), {
			env,
			judgeLlm: judge,
			judgeModelId: 'std-m',
			costTracker: tracker,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.2,
			estimateUsd: () => 0.001,
			logger: noopLogger,
		});
		expect(r.verdict).toBe(VERDICT.error);
	});

	it('captures only THIS case turn even if telegram.sent was non-empty before', async () => {
		const env = fakeEnv('clean reply');
		// Pollute env.sent with a prior turn — must not appear in the captured reply.
		env.telegram.pushReply('STALE REPLY FROM PRIOR CASE');
		const judge = new StubLLMService().queue('{"score": 5, "explanation": "ok"}');
		const tracker = { getMonthlyTotalCost: () => 0 };
		const r = await runChatbotCase(chatbotCase(), {
			env,
			judgeLlm: judge,
			judgeModelId: 'std-m',
			costTracker: tracker,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.2,
			estimateUsd: () => 0.001,
			logger: noopLogger,
		});
		// The actual response the runner sent to the judge must NOT contain
		// the stale text.
		expect(judge.lastPrompt).not.toContain('STALE REPLY FROM PRIOR CASE');
		expect(judge.lastPrompt).toContain('clean reply');
		expect(r.verdict).toBe(VERDICT.pass);
	});

	it('aborts with budget-exceeded before invoking routeMessage when over budget', async () => {
		const env = fakeEnv('reply');
		const judge = new StubLLMService();
		const cost = 0.18;
		const tracker = { getMonthlyTotalCost: () => cost };
		const r = await runChatbotCase(chatbotCase({ budgetUsd: 0.05 }), {
			env,
			judgeLlm: judge,
			judgeModelId: 'std-m',
			costTracker: tracker,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.1,
			logger: noopLogger,
		});
		expect(r.verdict).toBe(VERDICT.budgetExceeded);
		expect(env.routeMessage).not.toHaveBeenCalled();
	});

	it('fails when expectedHandler does not match the recorded handler (Codex I6)', async () => {
		const env = fakeEnv('reply text', 'chatbot-fallback'); // env records "chatbot-fallback"
		const judge = new StubLLMService().queue('{"score": 5, "explanation": "perfect"}');
		const tracker = { getMonthlyTotalCost: () => 0 };
		const c = chatbotCase({
			inputs: [
				{
					payload: 'How much did I spend at Costco?',
					expected: { expectedHandler: 'free-text-receipt-query' },
				},
			],
		});
		const r = await runChatbotCase(c, {
			env,
			judgeLlm: judge,
			judgeModelId: 'std-m',
			costTracker: tracker,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.2,
			estimateUsd: () => 0.001,
			logger: noopLogger,
		});
		expect(r.verdict).toBe(VERDICT.fail);
		expect(r.oracleVerdicts.some((v) => v.details.includes('routing mismatch'))).toBe(true);
	});

	it('calls endActiveSession before each input (Codex C3)', async () => {
		const env = fakeEnv('reply');
		const judge = new StubLLMService()
			.queue('{"score": 5, "explanation": "ok"}')
			.queue('{"score": 5, "explanation": "ok"}');
		const tracker = { getMonthlyTotalCost: () => 0 };
		const c = chatbotCase({
			inputs: [
				{ payload: 'first', expected: {} },
				{ payload: 'second', expected: {} },
			],
		});
		await runChatbotCase(c, {
			env,
			judgeLlm: judge,
			judgeModelId: 'std-m',
			costTracker: tracker,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.2,
			estimateUsd: () => 0.001,
			logger: noopLogger,
		});
		// One endActiveSession call per input (2 inputs → 2 calls)
		expect(env.endActiveSession).toHaveBeenCalledTimes(2);
	});

	it('rejects calls when oracle is not "rubric"', async () => {
		const env = fakeEnv('x');
		const judge = new StubLLMService();
		await expect(
			runChatbotCase(chatbotCase({ oracle: 'structural', rubric: undefined }), {
				env,
				judgeLlm: judge,
				judgeModelId: 'std-m',
				costTracker: { getMonthlyTotalCost: () => 0 },
				modelIds,
				cacheKey: 'k'.repeat(64),
				caseBudgetUsd: 0.2,
				estimateUsd: () => 0.001,
				logger: noopLogger,
			}),
		).rejects.toThrow(/oracle.*rubric/i);
	});
});
