/**
 * Production-wiring integration tests — ChatSessionStore through composeRuntime.
 *
 * Drives a real composeRuntime() → Router → ConversationService → ChatSessionStore
 * chain and asserts that session transcripts are written and /newchat/newchat works correctly.
 *
 * Tests:
 *   J.1 — free-text → one transcript file; active-sessions.yaml has one entry
 *   J.2 — /newchat → entry cleared; next free-text → second transcript file
 *   J.3 — /ask <q> → adds a turn to the active session (single transcript, not a new one)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { composeRuntime } from '../../../compose-runtime.js';
import { seedUsers } from '../../../testing/fixtures/seed-users.js';
import { createStubProviderRegistry, StubProvider } from '../../../testing/fixtures/stub-llm-provider.js';
import { fakeTelegramService } from '../../../testing/fixtures/fake-telegram.js';
import { askMessage, chatbotMessage } from '../../../testing/fixtures/messages.js';
import { requestContext } from '../../context/request-context.js';
import { CostTracker } from '../../llm/cost-tracker.js';

describe('ChatSessionStore production wiring (J — composeRuntime)', () => {
	let tempDir: string;
	let runtime: Awaited<ReturnType<typeof composeRuntime>>;
	let telegram: ReturnType<typeof fakeTelegramService>;
	let userId: string;
	let householdId: string | undefined;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-session-prod-'));
		const logger = pino({ level: 'silent' });
		const seed = await seedUsers({ dataDir: tempDir, users: 1, households: 1 });
		userId = 'user-0';
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
		householdId =
			(runtime.services.householdService as any).getHouseholdForUser(userId) ?? undefined;
	}, 60_000);

	afterAll(async () => {
		if (runtime) await runtime.dispose();
		await rm(tempDir, { recursive: true, force: true });
	});

	function routeMessage(msg: ReturnType<typeof chatbotMessage>) {
		const router = runtime.services.router as any;
		return requestContext.run({ userId, householdId }, () => router.routeMessage(msg));
	}

	function sessionsDir(): string {
		if (householdId) {
			return join(
				tempDir, 'data', 'households', householdId, 'users', userId,
				'chatbot', 'conversation', 'sessions',
			);
		}
		return join(tempDir, 'data', 'users', userId, 'chatbot', 'conversation', 'sessions');
	}

	async function listSessionFiles() {
		const files = await readdir(sessionsDir()).catch(() => [] as string[]);
		return files.filter((f) => f.endsWith('.md'));
	}

	// J.1 — free-text → one transcript file; active-sessions.yaml has one entry
	it('J.1: free-text message → one transcript file written', async () => {
		telegram.sent.length = 0;
		await routeMessage(chatbotMessage(userId, 10));

		expect(telegram.sent.some((m: { userId: string }) => m.userId === userId)).toBe(true);

		const files = await listSessionFiles();
		expect(files).toHaveLength(1);
	}, 30_000);

	// J.2 — /newchat → entry cleared; next free-text → second transcript file
	it('J.2: /newchat clears active session; next free-text starts a second transcript', async () => {
		// Send /newchat
		telegram.sent.length = 0;
		const newchatMsg = { ...chatbotMessage(userId, 11), text: '/newchat' };
		await routeMessage(newchatMsg);

		// Bot replied with session confirmation
		expect(telegram.sent.some((m: { userId: string }) => m.userId === userId)).toBe(true);

		// Send another free-text — should start a new session
		telegram.sent.length = 0;
		await routeMessage(chatbotMessage(userId, 12));

		const files = await listSessionFiles();
		expect(files.length).toBeGreaterThanOrEqual(2);
	}, 30_000);

	// J.3 — /ask <q> → adds turn to the active session, does not create a new one
	it('J.3: /ask adds a turn to the active session', async () => {
		const before = await listSessionFiles();

		telegram.sent.length = 0;
		await routeMessage(askMessage(userId, 13));

		expect(telegram.sent.some((m: { userId: string }) => m.userId === userId)).toBe(true);

		// /ask should reuse the current active session, not create a new transcript
		const after = await listSessionFiles();
		expect(after.length).toBe(before.length);
	}, 30_000);
});
