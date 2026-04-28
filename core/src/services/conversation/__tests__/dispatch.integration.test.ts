import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

describe('ConversationService production wiring (integration)', () => {
	let tempDir: string;
	let runtime: Awaited<ReturnType<typeof composeRuntime>>;
	let telegram: ReturnType<typeof fakeTelegramService>;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-conv-dispatch-'));
		const logger = pino({ level: 'silent' });
		const seed = await seedUsers({ dataDir: tempDir, users: 2, households: 1 });
		telegram = fakeTelegramService();

		const tempCostTracker = new CostTracker(join(tempDir, 'data'), logger);
		runtime = await composeRuntime({
			dataDir: join(tempDir, 'data'),
			configPath: seed.configPath,
			config: seed.config,
			providerRegistry: createStubProviderRegistry(tempCostTracker, logger),
			telegramService: telegram,
			logger,
		});
		runtime.services.providerRegistry.register(
			new StubProvider(runtime.services.costTracker as CostTracker, logger),
		);
	}, 60_000);

	afterAll(async () => {
		if (runtime) await runtime.dispose();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('free-text message → Router → ConversationService → telegram.send fires', async () => {
		const userId = 'user-0';
		const householdId =
			(runtime.services.householdService as any).getHouseholdForUser(userId) ?? undefined;

		telegram.sent.length = 0;
		const router = runtime.services.router as any;
		await requestContext.run({ userId, householdId }, () =>
			router.routeMessage(chatbotMessage(userId, 1)),
		);

		expect(telegram.sent.some((m: { userId: string }) => m.userId === userId)).toBe(true);
	}, 30_000);

	it('session transcript lands at household-aware scoped path (REQ-CONV-015)', async () => {
		const userId = 'user-0';
		const hh = (runtime.services.householdService as any).getHouseholdForUser(userId) as string;
		expect(hh).toBeTruthy();

		const router = runtime.services.router as any;
		await requestContext.run({ userId, householdId: hh }, () =>
			router.routeMessage(chatbotMessage(userId, 2)),
		);

		// ChatSessionStore.appendExchange() writes the transcript synchronously before resolving,
		// so the file is guaranteed to exist by the time routeMessage resolves.
		const sessionsDir = join(tempDir, 'data', 'households', hh, 'users', userId, 'chatbot', 'conversation', 'sessions');
		const { readdir } = await import('node:fs/promises');
		const files = await readdir(sessionsDir).catch(() => [] as string[]);
		const mdFiles = files.filter((f) => f.endsWith('.md'));
		expect(mdFiles.length).toBeGreaterThanOrEqual(1);

		const sessionPath = join(sessionsDir, mdFiles[0]!);
		const raw = await readFile(sessionPath, 'utf-8');
		expect(raw).toContain('source: telegram');
		expect(raw).toContain('user_id:');
	}, 30_000);

	it('per-user disable: when "chatbot" toggled off, ConversationService is not called', async () => {
		const userId = 'user-0';
		const hh = (runtime.services.householdService as any).getHouseholdForUser(userId) as string;

		const router = runtime.services.router as any;
		const conversationSvc = router.conversationService;
		expect(conversationSvc).toBeDefined();
		const handleMessageSpy = vi.spyOn(conversationSvc, 'handleMessage');

		const appToggle = router.appToggle;
		await appToggle.setEnabled(userId, 'chatbot', false);

		telegram.sent.length = 0;
		await requestContext.run({ userId, householdId: hh }, () =>
			router.routeMessage(chatbotMessage(userId, 3)),
		);

		expect(handleMessageSpy).not.toHaveBeenCalled();

		await appToggle.setEnabled(userId, 'chatbot', true);
		handleMessageSpy.mockRestore();
	}, 30_000);
});
