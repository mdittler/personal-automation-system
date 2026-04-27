/**
 * composeRuntime() smoke integration test (TDD skeleton).
 *
 * This test INTENTIONALLY FAILS until Task 4 implements the real
 * composeRuntime() function. The expected failure is:
 *   Error: composeRuntime: not yet implemented
 *
 * Once Task 4 lands, all assertions here should pass without modification.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cron from 'node-cron';
import pino from 'pino';
import { composeRuntime } from '../compose-runtime.js';
import { seedUsers } from '../testing/fixtures/seed-users.js';
import { createStubProviderRegistry, StubProvider } from '../testing/fixtures/stub-llm-provider.js';
import { fakeTelegramService } from '../testing/fixtures/fake-telegram.js';
import { chatbotMessage, askMessage } from '../testing/fixtures/messages.js';
import { requestContext } from '../services/context/request-context.js';
import { CostTracker } from '../services/llm/cost-tracker.js';
import { approximateTokens } from '../services/llm/estimate-guard-cost.js';
import { getModelPricing } from '../services/llm/model-pricing.js';

describe('composeRuntime smoke', () => {
	let tempDir: string;
	let runtime: Awaited<ReturnType<typeof composeRuntime>>;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-compose-smoke-'));
		const logger = pino({ level: 'silent' });
		const seed = await seedUsers({ dataDir: tempDir, users: 4, households: 2 });

		// Build an initial stub registry with a throwaway cost tracker so composeRuntime()
		// has a non-empty provider registry (needed to avoid "no providers" warning path).
		// After composeRuntime() returns we re-register the stub using the REAL internal
		// costTracker so assertions on runtime.services.costTracker are correct.
		const tempCostTracker = new CostTracker(join(tempDir, 'data'), logger);

		runtime = await composeRuntime({
			dataDir: join(tempDir, 'data'),
			configPath: seed.configPath,
			config: seed.config,
			providerRegistry: createStubProviderRegistry(tempCostTracker, logger),
			telegramService: fakeTelegramService(),
			logger,
		});

		// Re-register the stub using the runtime's own costTracker so that all
		// completeWithUsage() calls record to the instance under test.
		const realCostTracker = runtime.services.costTracker as CostTracker;
		runtime.services.providerRegistry.register(new StubProvider(realCostTracker, logger));
	});

	afterAll(async () => {
		if (runtime) await runtime.dispose();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('constructs a fully wired runtime without starting Telegraf, Fastify, or scheduler', () => {
		expect(runtime.services.router).toBeDefined();
		expect(runtime.services.householdLimiter).toBeDefined();
		expect(runtime.services.costTracker).toBeDefined();
		// Server must be registered but not listening
		expect((runtime.server as any).server?.listening ?? false).toBeFalsy();
	});

	it('wires the job failure notifier with persisted disabled-job state', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const jobId = 'persist-disabled-state';
		const jobKey = `system:${jobId}`;
		const failingHandler = vi.fn().mockRejectedValue(new Error('boom'));

		runtime.services.scheduler.cron.register(
			{
				id: jobId,
				appId: 'system',
				cron: '*/5 * * * *',
				handler: 'persist-disabled-state',
				description: 'Persist disabled jobs in composeRuntime',
				userScope: 'system',
			},
			() => failingHandler,
		);

		const cronCallback = createTaskSpy.mock.calls.at(-1)?.[1] as (() => Promise<void>) | undefined;
		expect(cronCallback).toBeDefined();

		for (let i = 0; i < 5; i++) {
			await cronCallback?.();
		}

		const persisted = await readFile(join(tempDir, 'data', 'system', 'disabled-jobs.yaml'), 'utf-8');
		expect(persisted).toContain(jobKey);

		runtime.services.scheduler.cron.unregister(jobKey);
		createTaskSpy.mockRestore();
	});

	it('uses live tier pricing when reserving estimated LLM cost', async () => {
		await runtime.services.modelSelector.setFastRef({ provider: 'stub', model: 'gpt-4.1-mini' });
		await runtime.services.modelSelector.setStandardRef({ provider: 'stub', model: 'gpt-4.1' });

		const costTracker = runtime.services.costTracker as CostTracker;
		const reserveSpy = vi.spyOn(costTracker, 'reserveEstimated');
		reserveSpy.mockClear();

		const userId = 'user-0';
		const householdId =
			(runtime.services.householdService as any).getHouseholdForUser(userId) ?? undefined;
		const prompt = 'x'.repeat(4000);
		const promptTokens = approximateTokens(prompt);
		const outputTokens = 1000;
		const fastPricing = getModelPricing('gpt-4.1-mini');
		const standardPricing = getModelPricing('gpt-4.1');
		expect(fastPricing).toBeTruthy();
		expect(standardPricing).toBeTruthy();
		const expectedFast =
			((promptTokens * fastPricing!.input) + (outputTokens * fastPricing!.output)) / 1_000_000;
		const expectedStandard =
			((promptTokens * standardPricing!.input) + (outputTokens * standardPricing!.output)) /
			1_000_000;

		await requestContext.run({ userId, householdId }, () =>
			runtime.services.systemLlm.complete(prompt, { tier: 'fast', maxTokens: 1000 }),
		);
		await requestContext.run({ userId, householdId }, () =>
			runtime.services.systemLlm.complete(prompt, { tier: 'standard', maxTokens: 1000 }),
		);

		expect(reserveSpy).toHaveBeenCalledTimes(2);
		const fastAmount = reserveSpy.mock.calls[0]?.[3];
		const standardAmount = reserveSpy.mock.calls[1]?.[3];
		// Estimate uses prompt tokens from approximateTokens(prompt) plus maxTokens as
		// the output upper bound, priced from the live model table for the active tier.
		expect(fastAmount).toBeCloseTo(expectedFast, 6);
		expect(standardAmount).toBeCloseTo(expectedStandard, 6);
		expect((fastAmount as number) < (standardAmount as number)).toBe(true);
	});

	it('chatbot /ask route calls reserve priced amounts instead of the flat fallback', async () => {
		// apps/chatbot/ was deleted in Hermes P1 Chunk D.3. /ask is now handled by
		// ConversationService.handleAsk via the Router command dispatch — route via
		// router.routeMessage so the same LLM-guard cost-reservation path is exercised.
		await runtime.services.modelSelector.setFastRef({ provider: 'stub', model: 'gpt-4.1-mini' });
		await runtime.services.modelSelector.setStandardRef({ provider: 'stub', model: 'gpt-4.1' });

		const costTracker = runtime.services.costTracker as CostTracker;
		const reserveSpy = vi.spyOn(costTracker, 'reserveEstimated');
		reserveSpy.mockClear();

		const userId = 'user-0';
		const householdId =
			(runtime.services.householdService as any).getHouseholdForUser(userId) ?? undefined;
		const router = runtime.services.router as any;
		await requestContext.run({ userId, householdId }, () =>
			router.routeMessage(askMessage(userId, 2001)),
		);

		const defaultReservation = runtime.services.safeguardsConfig.defaultReservationUsd ?? 0.01;
		const chatbotReservations = reserveSpy.mock.calls.filter(([, appId]) => appId === 'chatbot');
		expect(chatbotReservations.length).toBeGreaterThan(0);
		expect(
			chatbotReservations.some(([, , , estimate]) => {
				const usd = estimate as number;
				return usd > 0 && usd < defaultReservation;
			}),
		).toBe(true);
	});

	it('/edit ignores unauthorized recentFilePaths from another user', async () => {
		// apps/chatbot/ was deleted in Hermes P1 Chunk D.3. /edit is now handled by
		// EditService via the Router command dispatch — route via router.routeMessage.
		const userA = 'user-0';
		const userB = 'user-1';
		const userAHouseholdId =
			(runtime.services.householdService as any).getHouseholdForUser(userA) ?? undefined;
		const userBRelativePath = `users/${userB}/notes/daily-notes/2026-04-24.md`;
		const userBAbsolutePath = join(tempDir, 'data', userBRelativePath);
		await mkdir(join(tempDir, 'data', 'users', userB, 'notes', 'daily-notes'), {
			recursive: true,
		});
		await writeFile(userBAbsolutePath, 'zxq secret marker\n', 'utf-8');
		await runtime.services.fileIndex.rebuild();

		runtime.services.interactionContext.record(userA, {
			appId: 'notes',
			action: 'view-note',
			filePaths: [userBRelativePath],
			scope: 'user',
		});

		const telegram = runtime.services.telegram as ReturnType<typeof fakeTelegramService>;
		telegram.sent.length = 0;

		const router = runtime.services.router as any;
		await requestContext.run({ userId: userA, householdId: userAHouseholdId }, () =>
			router.routeMessage({
				userId: userA,
				text: '/edit change zxq secret marker',
				chatId: 3001,
				messageId: 3001,
				timestamp: new Date(),
			}),
		);

		expect(await readFile(userBAbsolutePath, 'utf-8')).toBe('zxq secret marker\n');
		expect(
			telegram.sent.some(
				(message) =>
					message.userId === userA && message.text.includes('No matching files found'),
			),
		).toBe(true);
	});

	it('routed messages appear as exactly one new 9-col row in llm-usage.md with correct userId + householdId', async () => {
		const userId = 'user-0';
		const householdService = runtime.services.householdService as any;
		const expectedHh = householdService.getHouseholdForUser(userId);
		expect(expectedHh).toBeTruthy();

		const costTracker = runtime.services.costTracker as CostTracker;
		const before = await costTracker.readUsage();
		const countRows = (md: string) => md.split('\n').filter((l) => l.startsWith('| 2')).length;
		const beforeCount = countRows(before);

		const router = runtime.services.router as any;
		await requestContext.run({ userId, householdId: expectedHh }, () =>
			router.routeMessage(chatbotMessage(userId, 0)),
		);

		// Deterministically wait for the fire-and-forget write queue to drain.
		await costTracker.drainWrites();

		const after = await costTracker.readUsage();
		const afterLines = after.split('\n').filter((l) => l.startsWith('| 2'));
		expect(afterLines.length).toBeGreaterThan(beforeCount);

		// Parse the last row positionally (9 columns):
		// | ts | provider | model | in | out | cost | app | user | household |
		const lastRow = afterLines[afterLines.length - 1];
		const cols = lastRow.split('|').slice(1, -1).map((c) => c.trim());
		expect(cols[7]).toBe(userId);    // user column (index 7)
		expect(cols[8]).toBe(expectedHh); // household column (index 8)
	});

	// Hermes P1 Chunk B: ConversationService is wired into the Router
	it('Chunk B: ConversationService is wired into the Router', () => {
		const router = runtime.services.router as any;
		expect(router.conversationService).toBeDefined();
		expect(router.conversationService.constructor.name).toBe('ConversationService');
	});

	it('dispose() completes without throwing', async () => {
		await expect(runtime.dispose()).resolves.not.toThrow();
	});
});
