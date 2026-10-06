/**
 * One agent trial (REQ-REG-AGENT-002): build an environment, play the user
 * turns through the real router, grade with the outcome oracle, dispose.
 * Runs inside the per-trial worker process (Task 10) so Food's module-level
 * state (pending flows, caches) can never carry between trials.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MessageContext, PhotoContext } from '@core/types/telegram.js';
import type { AgentExpectation, AgentTaskPayload } from '../cases/agent/types.js';
import { evaluateOutcome, snapshotPaths } from '../oracles/outcome.js';

export interface AgentEnvLike {
	userId: string;
	householdId: string;
	dataDir: string;
	telegram: { sent: ReadonlyArray<{ userId: string; text: string }> };
	routeMessage: (ctx: MessageContext) => Promise<void>;
	routePhoto: (ctx: PhotoContext) => Promise<void>;
	dispose: () => Promise<void>;
}

interface CostMeter {
	getMonthlyTotalCost: () => number;
	getTokenUsageTotals: () => { input: number; output: number };
}

export interface AgentTrialRequest {
	caseId: string;
	trial: number;
	repeats: number;
	payload: AgentTaskPayload;
	expectation: AgentExpectation;
}

export interface AgentTrialOutcome {
	verdict: 'pass' | 'fail' | 'error';
	details: string;
	transcript: string;
	costUsd: number;
	tokenIn: number;
	tokenOut: number;
	durationMs: number;
}

function mimeFor(path: string): string {
	return path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

interface TrialHooks {
	/**
	 * Provider-level failures recorded during the trial (the app layer swallows
	 * LLM errors into polite replies, so grading the reply would turn an outage
	 * into a cached `fail`). Any new entry forces the trial verdict to `error`.
	 */
	infraErrors?: () => readonly string[];
	/** Called after each turn with cumulative spend, so a crashed worker's cost is not lost. */
	onMeter?: (m: { costUsd: number; tokenIn: number; tokenOut: number }) => void;
	/**
	 * Wait for provider calls the app started but did not await (e.g. Food's
	 * parallel shadow classifier) so their spend and errors are measured before
	 * grading and before the worker exits.
	 */
	drain?: () => Promise<void>;
}

export async function runAgentTrial(
	req: AgentTrialRequest,
	makeEnv: (overlay?: string) => Promise<AgentEnvLike>,
	meter: CostMeter,
	/** Photo turn paths are resolved against this (the repo root in production). */
	repoRoot: string,
	hooks: TrialHooks = {},
): Promise<AgentTrialOutcome> {
	const start = Date.now();
	const costBefore = meter.getMonthlyTotalCost();
	const tokBefore = meter.getTokenUsageTotals();
	const infraBefore = hooks.infraErrors?.().length ?? 0;
	const spent = () => {
		const tok = meter.getTokenUsageTotals();
		return {
			costUsd: Math.max(0, meter.getMonthlyTotalCost() - costBefore),
			tokenIn: Math.max(0, tok.input - tokBefore.input),
			tokenOut: Math.max(0, tok.output - tokBefore.output),
		};
	};
	const label = `trial ${req.trial}/${req.repeats}`;
	const replies: string[] = [];
	let env: AgentEnvLike | undefined;
	let verdict: AgentTrialOutcome['verdict'];
	let details: string;
	try {
		env = await makeEnv(req.payload.overlay);
		const ctx = { dataDir: env.dataDir, householdId: env.householdId, userId: env.userId };
		const before = await snapshotPaths(req.expectation.unchanged ?? [], ctx);
		for (let i = 0; i < req.payload.turns.length; i++) {
			const turn = req.payload.turns[i]!;
			const beforeCount = env.telegram.sent.length;
			const base = {
				userId: env.userId,
				timestamp: new Date(),
				chatId: 20_000 + req.trial,
				messageId: i + 1,
			};
			if ('text' in turn) {
				await env.routeMessage({ ...base, text: turn.text });
			} else {
				await env.routePhoto({
					...base,
					photo: await readFile(join(repoRoot, turn.photo)),
					mimeType: mimeFor(turn.photo),
					...(turn.caption !== undefined ? { caption: turn.caption } : {}),
				});
			}
			const userId = env.userId;
			replies.push(
				env.telegram.sent
					.slice(beforeCount)
					.filter((m) => m.userId === userId)
					.map((m) => m.text)
					.join('\n'),
			);
			hooks.onMeter?.(spent());
		}
		await hooks.drain?.();
		const userId = env.userId;
		const externalMessages = env.telegram.sent.filter((m) => m.userId !== userId).length;
		const outcome = await evaluateOutcome({
			replies,
			expectation: req.expectation,
			ctx,
			before,
			externalMessages,
		});
		const infra = hooks.infraErrors?.().slice(infraBefore) ?? [];
		if (infra.length > 0) {
			verdict = 'error';
			details = `${label}: provider error(s) during trial: ${infra.slice(0, 3).join(' | ')}`;
		} else {
			verdict = outcome.pass ? 'pass' : 'fail';
			details = `${label}: ${outcome.pass ? 'all checks passed' : outcome.failures.join('; ')}`;
		}
	} catch (err) {
		verdict = 'error';
		details = `${label}: threw: ${(err as Error).message}`;
	} finally {
		if (env) await env.dispose();
	}
	const durationMs = Date.now() - start;
	return {
		verdict,
		details: `${details} (${durationMs} ms)`,
		transcript: replies.join('\n---\n'),
		...spent(),
		durationMs,
	};
}
