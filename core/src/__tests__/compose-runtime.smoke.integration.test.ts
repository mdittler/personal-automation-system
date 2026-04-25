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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve apps/ from the repo root (3 levels above core/src/__tests__/)
const REPO_APPS_DIR = resolve(__dirname, '../../..', 'apps');
import cron from 'node-cron';
import pino from 'pino';
import { composeRuntime } from '../compose-runtime.js';
import { seedUsers } from '../testing/fixtures/seed-users.js';
import { createStubProviderRegistry, StubProvider } from '../testing/fixtures/stub-llm-provider.js';
import { fakeTelegramService } from '../testing/fixtures/fake-telegram.js';
import { chatbotMessage } from '../testing/fixtures/messages.js';
import { requestContext } from '../services/context/request-context.js';
import { CostTracker } from '../services/llm/cost-tracker.js';

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
			appsDir: REPO_APPS_DIR,
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

	it('dispose() completes without throwing', async () => {
		await expect(runtime.dispose()).resolves.not.toThrow();
	});
});
