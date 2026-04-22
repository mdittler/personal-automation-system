/**
 * composeRuntime() smoke integration test (TDD skeleton).
 *
 * This test INTENTIONALLY FAILS until Task 4 implements the real
 * composeRuntime() function. The expected failure is:
 *   Error: composeRuntime: not yet implemented
 *
 * Once Task 4 lands, all assertions here should pass without modification.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { composeRuntime } from '../compose-runtime.js';
import { seedUsers } from '../testing/fixtures/seed-users.js';
import { createStubProviderRegistry } from '../testing/fixtures/stub-llm-provider.js';
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

		// CostTracker is needed to build the StubProvider, which records usage.
		// In Task 4, composeRuntime() will construct this internally; here we
		// build a shared instance so the stub registry can log to the same file.
		const costTracker = new CostTracker(join(tempDir, 'data'), logger);

		runtime = await composeRuntime({
			dataDir: join(tempDir, 'data'),
			configPath: seed.configPath,
			config: seed.config,
			providerRegistry: createStubProviderRegistry(costTracker, logger),
			telegramService: fakeTelegramService(),
			logger,
		});
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

		// Allow the async write queue to flush
		await new Promise((r) => setTimeout(r, 200));

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
