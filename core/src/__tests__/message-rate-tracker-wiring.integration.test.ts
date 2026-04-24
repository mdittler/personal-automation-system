import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeRuntime, type RuntimeHandle } from '../compose-runtime.js';
import { requestContext } from '../services/context/request-context.js';
import { CostTracker } from '../services/llm/cost-tracker.js';
import { MessageRateTracker } from '../services/metrics/message-rate-tracker.js';
import { fakeTelegramService } from '../testing/fixtures/fake-telegram.js';
import { chatbotMessage } from '../testing/fixtures/messages.js';
import { seedUsers } from '../testing/fixtures/seed-users.js';
import { createStubProviderRegistry, StubProvider } from '../testing/fixtures/stub-llm-provider.js';

const logger = pino({ level: 'silent' });

async function buildRuntime(tempDir: string): Promise<RuntimeHandle> {
	const seed = await seedUsers({ dataDir: tempDir, users: 4, households: 2 });
	const tempCostTracker = new CostTracker(join(tempDir, 'data'), logger);

	const runtime = await composeRuntime({
		dataDir: join(tempDir, 'data'),
		configPath: seed.configPath,
		config: seed.config,
		providerRegistry: createStubProviderRegistry(tempCostTracker, logger),
		telegramService: fakeTelegramService(),
		logger,
	});

	const realCostTracker = runtime.services.costTracker as CostTracker;
	runtime.services.providerRegistry.register(new StubProvider(realCostTracker, logger));
	return runtime;
}

describe('MessageRateTracker production wiring', () => {
	let tempDir: string;
	let runtime: RuntimeHandle | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-message-rate-tracker-'));
		runtime = await buildRuntime(tempDir);
	});

	afterEach(async () => {
		if (runtime) {
			await runtime.dispose();
		}
		vi.restoreAllMocks();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('records the active household when the composed runtime router handles a message', async () => {
		const recordSpy = vi.spyOn(MessageRateTracker.prototype, 'recordMessage');
		const userId = 'user-0';
		const householdId = runtime?.services.householdService.getHouseholdForUser(userId);

		expect(householdId).toBeTruthy();

		await requestContext.run({ userId, householdId }, () =>
			runtime?.services.router.routeMessage(chatbotMessage(userId, 0)) ?? Promise.resolve(),
		);

		expect(recordSpy).toHaveBeenCalledOnce();
		expect(recordSpy).toHaveBeenCalledWith(householdId);
	});

	it('disposes the tracker through the runtime shutdown path', async () => {
		const disposeSpy = vi.spyOn(MessageRateTracker.prototype, 'dispose');

		await runtime?.dispose();
		runtime = undefined;

		expect(disposeSpy).toHaveBeenCalledOnce();
	});
});
