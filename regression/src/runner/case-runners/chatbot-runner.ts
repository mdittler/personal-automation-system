/**
 * Chatbot case-runner (REQ-REG-005 + REQ-REG-012).
 *
 * For each input:
 *   1. Pre-charge gate (REQ-REG-008).
 *   2. Codex C3: end active session before dispatch so cache-skip ordering
 *      cannot leak prior turns into the next case.
 *   3. Snapshot telegram.sent length.
 *   4. Run `env.routeMessage(ctx)` (caller is responsible for requestContext binding).
 *   5. Capture every NEW message appended to telegram.sent for the user.
 *   6. Codex I6: register one-shot handler capture; if expectedHandler !== actual,
 *      append a structural-fail oracle verdict alongside the rubric verdict.
 *   7. Run the rubric oracle (judge LLM call).
 *   8. Aggregate cost (route's many internal LLM calls + judge call all
 *      land in the CostTracker delta).
 *
 * The env abstraction is deliberately small so unit tests can inject a
 * stub instead of composing the full runtime.
 */

import type { LLMService } from '@core/types/llm.js';
import type {
	OracleVerdict,
	PersonaCase,
	RunResult,
	TierModelSnapshot,
	Verdict,
} from '@core/types/regression.js';
import { VERDICT } from '@core/types/regression.js';
import { runRubricOracle } from '../../oracles/rubric.js';
import type { MinimalLogger } from './routing-runner.js';

export interface ChatbotEnvLike {
	userId: string;
	householdId: string;
	telegram: { sent: ReadonlyArray<{ userId: string; text: string }> };
	routeMessage: (ctx: {
		userId: string;
		text: string;
		chatId: number;
		messageId: number;
		timestamp: Date;
	}) => Promise<void>;
	/**
	 * Codex I6 — register a one-shot handler-diagnostic listener that records
	 * which handler was invoked for the next routeMessage. Returns a function
	 * that returns the recorded handler id (or null if none was recorded).
	 */
	captureHandler(): () => string | null;
	/** End the active session (used between cases — Codex C3). */
	endActiveSession(): Promise<void>;
}

export interface ChatbotRunnerDeps {
	env: ChatbotEnvLike;
	judgeLlm: Pick<LLMService, 'complete'>;
	judgeModelId: string;
	costTracker: {
		getMonthlyTotalCost: () => number;
		getTokenUsageTotals: () => { input: number; output: number };
	};
	modelIds: TierModelSnapshot;
	cacheKey: string;
	caseBudgetUsd: number;
	estimateUsd: (call: { tokenIn: number; tokenOut: number }) => number;
	logger: MinimalLogger;
}

export async function runChatbotCase(c: PersonaCase, deps: ChatbotRunnerDeps): Promise<RunResult> {
	if (c.oracle !== 'rubric') {
		throw new Error(`chatbot-runner: oracle must be 'rubric' (case: ${c.id}, got ${c.oracle})`);
	}
	if (!c.rubric) {
		throw new Error(`chatbot-runner: rubric required (case: ${c.id})`);
	}

	const start = Date.now();
	const actuals: string[] = [];
	const oracleVerdicts: OracleVerdict[] = [];
	let costUsd = 0;
	let tokenIn = 0;
	let tokenOut = 0;
	let verdict: Verdict = VERDICT.pass;

	for (let i = 0; i < c.inputs.length; i++) {
		const input = c.inputs[i]!;
		const projected = deps.estimateUsd({ tokenIn: 4000, tokenOut: 400 });
		if (costUsd + projected > deps.caseBudgetUsd) {
			if (verdict === VERDICT.pass) verdict = VERDICT.budgetExceeded;
			deps.logger.warn(
				{ caseId: c.id, costUsd, projected, budget: deps.caseBudgetUsd },
				'chatbot-runner: case budget exceeded — aborting input loop',
			);
			break;
		}

		// Codex C3 — clear active session between inputs so cache-skip ordering
		// can't leak prior turns into the next case. Safe no-op if no session.
		await deps.env.endActiveSession();

		const beforeCount = deps.env.telegram.sent.length;
		const beforeCost = deps.costTracker.getMonthlyTotalCost();
		const tokBefore = deps.costTracker.getTokenUsageTotals();
		// Declared before try so finally can assign and post-block code can read.
		let tokAfter = tokBefore;
		const readHandler = deps.env.captureHandler();
		let routeErr: unknown;
		let oracle: Awaited<ReturnType<typeof runRubricOracle>> | undefined;
		try {
			await deps.env.routeMessage({
				userId: deps.env.userId,
				text: String(input.payload),
				chatId: 10_000 + i,
				messageId: i + 1,
				timestamp: new Date(),
			});

			const newMessages = deps.env.telegram.sent
				.slice(beforeCount)
				.filter((m) => m.userId === deps.env.userId)
				.map((m) => m.text)
				.join('\n');
			actuals.push(newMessages);

			// Codex I6 — assert routing correctness BEFORE grading reply quality.
			// expectedHandler lives on PersonaInput.expected.expectedHandler.
			const expected = (input.expected as { expectedHandler?: string }).expectedHandler;
			const actualHandler = readHandler();
			if (expected && actualHandler !== null && actualHandler !== expected) {
				oracleVerdicts.push({
					verdict: VERDICT.fail,
					details: `routing mismatch: expected handler '${expected}', got '${actualHandler}'`,
				});
				if (verdict === VERDICT.pass) verdict = VERDICT.fail;
			} else if (expected && actualHandler === null) {
				oracleVerdicts.push({
					verdict: VERDICT.error,
					details: `routing diagnostic captured no handler for case ${c.id} (env did not record one)`,
				});
				verdict = VERDICT.error;
			}

			oracle = await runRubricOracle({
				rubric: c.rubric,
				actualResponse: newMessages,
				deps: {
					llm: deps.judgeLlm,
					standardModelId: deps.judgeModelId,
					logger: deps.logger,
					costMeter: deps.costTracker,
				},
			});
		} catch (err) {
			routeErr = err;
		} finally {
			// Read after regardless of throw — tokens spent before any error are counted.
			tokAfter = deps.costTracker.getTokenUsageTotals();
		}

		const afterCost = deps.costTracker.getMonthlyTotalCost();
		costUsd += Math.max(0, afterCost - beforeCost);
		tokenIn += Math.max(0, tokAfter.input - tokBefore.input);
		tokenOut += Math.max(0, tokAfter.output - tokBefore.output);

		if (routeErr !== undefined) {
			oracleVerdicts.push({
				verdict: VERDICT.error,
				details: `routeMessage threw: ${(routeErr as Error).message}`,
			});
			verdict = VERDICT.error;
			actuals.push('');
			continue;
		}

		if (oracle !== undefined) {
			oracleVerdicts.push(oracle.verdict);
			if (oracle.verdict.verdict === VERDICT.fail && verdict === VERDICT.pass)
				verdict = VERDICT.fail;
			if (oracle.verdict.verdict === VERDICT.error) verdict = VERDICT.error;
		}
	}

	return {
		caseId: c.id,
		cacheKey: deps.cacheKey,
		source: 'fresh',
		verdict,
		inputs: c.inputs,
		actuals,
		oracleVerdicts,
		tokenCounts: { input: tokenIn, output: tokenOut },
		costUsd,
		modelIds: deps.modelIds,
		evaluatedTier: 'standard',
		timestamp: new Date().toISOString(),
		durationMs: Date.now() - start,
	};
}
