import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { composeRuntime } from '../../../compose-runtime.js';
import { seedUsers } from '../../../testing/fixtures/seed-users.js';
import { createStubProviderRegistry, StubProvider } from '../../../testing/fixtures/stub-llm-provider.js';
import { fakeTelegramService } from '../../../testing/fixtures/fake-telegram.js';
import { chatbotMessage } from '../../../testing/fixtures/messages.js';
import { requestContext } from '../../context/request-context.js';
import { CostTracker } from '../../llm/cost-tracker.js';
import { CONVERSATION_USER_CONFIG } from '../manifest.js';
import { VIRTUAL_CHATBOT_PATH } from '../virtual-app.js';

describe('virtual chatbot registry entry — when real app is absent', () => {
	let tempDir: string;
	let runtime: Awaited<ReturnType<typeof composeRuntime>>;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-virtual-chatbot-only-'));
		const logger = pino({ level: 'silent' });
		const seed = await seedUsers({ dataDir: tempDir, users: 1, households: 1 });
		const tempCostTracker = new CostTracker(join(tempDir, 'data'), logger);
		// appsDir points at a non-existent directory — no real apps loaded.
		// The virtual chatbot entry must be registered unconditionally by compose-runtime.
		runtime = await composeRuntime({
			dataDir: join(tempDir, 'data'),
			configPath: seed.configPath,
			config: seed.config,
			providerRegistry: createStubProviderRegistry(tempCostTracker, logger),
			telegramService: fakeTelegramService(),
			logger,
			appsDir: join(tempDir, 'no-apps'),
		});
		runtime.services.providerRegistry.register(
			new StubProvider(runtime.services.costTracker as CostTracker, logger),
		);
	}, 60_000);

	afterAll(async () => {
		if (runtime) await runtime.dispose();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('registry.getApp("chatbot") resolves to a virtual entry tagged <virtual:chatbot>', () => {
		const app = runtime.services.registry.getApp('chatbot');
		expect(app).toBeDefined();
		expect(app?.appDir).toBe(VIRTUAL_CHATBOT_PATH);
		expect(app?.manifest.user_config).toEqual(CONVERSATION_USER_CONFIG);
	});

	it('virtual chatbot module.handleMessage throws (regression tripwire)', async () => {
		const app = runtime.services.registry.getApp('chatbot');
		await expect(
			app!.module.handleMessage({ userId: 'user-0', text: 'hi' } as any),
		).rejects.toThrow(/virtual/i);
	});

	it('Router free-text dispatch reaches ConversationService.handleMessage and NEVER the virtual module.handleMessage', async () => {
		const userId = 'user-0';
		const householdId =
			(runtime.services.householdService as any).getHouseholdForUser(userId) ?? undefined;

		const virtualApp = runtime.services.registry.getApp('chatbot')!;
		const virtualSpy = vi.spyOn(virtualApp.module, 'handleMessage');
		const conversationSpy = vi.spyOn(
			(runtime.services.router as any).conversationService,
			'handleMessage',
		);

		await requestContext.run({ userId, householdId }, () =>
			(runtime.services.router as any).routeMessage(chatbotMessage(userId, 1)),
		);

		expect(conversationSpy).toHaveBeenCalledTimes(1);
		expect(virtualSpy).not.toHaveBeenCalled();

		virtualSpy.mockRestore();
		conversationSpy.mockRestore();
	}, 30_000);
});
