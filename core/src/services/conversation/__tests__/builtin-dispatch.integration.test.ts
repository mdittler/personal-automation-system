/**
 * Integration test — Router → ConversationService built-in dispatch (Hermes P1 Chunk C).
 *
 * Builds the full runtime via composeRuntime() and drives messages through the Router.
 * Verifies that /ask, /edit, /notes reach the ConversationService (spy on public methods)
 * and that /notes on + subsequent free-text produces a daily-notes file on disk.
 *
 * Scope: this is the only test file that exercises the full graph end-to-end.
 * All other Chunk C tests stay at the unit / persona slice.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { composeRuntime } from '../../../compose-runtime.js';
import { seedUsers } from '../../../testing/fixtures/seed-users.js';
import {
	createStubProviderRegistry,
	StubProvider,
} from '../../../testing/fixtures/stub-llm-provider.js';
import { fakeTelegramService } from '../../../testing/fixtures/fake-telegram.js';
import { requestContext } from '../../context/request-context.js';
import { CostTracker } from '../../llm/cost-tracker.js';

describe('ConversationService built-in dispatch (integration)', () => {
	let tempDir: string;
	let runtime: Awaited<ReturnType<typeof composeRuntime>>;
	let telegram: ReturnType<typeof fakeTelegramService>;
	let userId: string;
	let householdId: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-conv-builtin-'));
		const logger = pino({ level: 'silent' });
		const seed = await seedUsers({ dataDir: tempDir, users: 1, households: 1 });
		telegram = fakeTelegramService();
		userId = seed.users[0]!.id;
		householdId = seed.users[0]!.householdId;

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

	function route(text: string) {
		const router = runtime.services.router as any;
		return requestContext.run({ userId, householdId }, () =>
			router.routeMessage({
				userId,
				text,
				chatId: 999,
				messageId: 1,
				timestamp: new Date(),
			}),
		);
	}

	it('/ask dispatches to conversationService.handleAsk (not chatbot.handleCommand)', async () => {
		const convSvc = (runtime.services.router as any).conversationService;
		expect(convSvc).toBeDefined();
		const handleAskSpy = vi.spyOn(convSvc, 'handleAsk');

		telegram.sent.length = 0;
		await route('/ask what apps do I have?');

		expect(handleAskSpy).toHaveBeenCalledOnce();
		// Args are the space-split tokens (no leading slash)
		const [args] = handleAskSpy.mock.calls[0] as [string[]];
		expect(args).toEqual(['what', 'apps', 'do', 'I', 'have?']);

		handleAskSpy.mockRestore();
	}, 30_000);

	it('/edit dispatches to conversationService.handleEdit (not chatbot.handleCommand)', async () => {
		const convSvc = (runtime.services.router as any).conversationService;
		const handleEditSpy = vi.spyOn(convSvc, 'handleEdit');

		telegram.sent.length = 0;
		await route('/edit fix typo in grocery list');

		expect(handleEditSpy).toHaveBeenCalledOnce();
		const [args] = handleEditSpy.mock.calls[0] as [string[]];
		expect(args).toEqual(['fix', 'typo', 'in', 'grocery', 'list']);

		handleEditSpy.mockRestore();
	}, 30_000);

	it('/notes on → telegram confirmation received + handleNotes reached', async () => {
		const convSvc = (runtime.services.router as any).conversationService;
		const handleNotesSpy = vi.spyOn(convSvc, 'handleNotes');

		telegram.sent.length = 0;
		await route('/notes on');

		expect(handleNotesSpy).toHaveBeenCalledOnce();
		const [args] = handleNotesSpy.mock.calls[0] as [string[]];
		expect(args).toEqual(['on']);
		// User-facing confirmation was sent
		expect(telegram.sent.some((m) => m.userId === userId && /ON/i.test(m.text))).toBe(true);

		handleNotesSpy.mockRestore();
	}, 30_000);

	it('/notes on + free text → daily-notes file created on disk (opt-in gate working)', async () => {
		// Enable daily notes for this user (may already be on from previous test)
		await route('/notes on');

		telegram.sent.length = 0;
		await route('hi this is my first logged message');

		// daily-notes file should exist under the household-scoped path
		const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
		const notesPath = join(
			tempDir,
			'data',
			'households',
			householdId,
			'users',
			userId,
			'chatbot',
			`daily-notes/${today}.md`,
		);
		const contents = await readFile(notesPath, 'utf-8');
		expect(contents).toContain('hi this is my first logged message');
	}, 30_000);

	it('override file on disk contains ONLY { log_to_notes: true } — no manifest defaults materialized', async () => {
		// /notes on was already called in the previous test; check the resulting override file
		const overridePath = join(
			tempDir,
			'data',
			'system',
			'app-config',
			'chatbot',
			`${userId}.yaml`,
		);
		const raw = await readFile(overridePath, 'utf-8');

		// Parse YAML (simple: split on newlines and look for keys)
		// The file should only contain log_to_notes, not auto_detect_pas or other manifest defaults
		expect(raw).toContain('log_to_notes');
		// Ensure manifest defaults like auto_detect_pas were NOT written
		expect(raw).not.toContain('auto_detect_pas');
	}, 30_000);
});
