/**
 * compose-runtime settings registry wiring (Task 1.6 + Task 3.7).
 *
 * Verifies that composeRuntime() exposes a SettingsRegistry on the returned
 * services bag and that it contains the chatbot virtual keys without
 * double-registering them. Also verifies that SettingsReader is wired and
 * produces a non-empty catalog for the chatbot virtual keys (Task 3.7).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeRuntime } from '../compose-runtime.js';
import { CostTracker } from '../services/llm/cost-tracker.js';
import type { ConversationRetrievalService } from '../services/conversation-retrieval/conversation-retrieval-service.js';
import { SettingsRegistry, SettingsWriter } from '../services/settings/index.js';
import { requestContext } from '../services/context/request-context.js';
import { fakeTelegramService } from '../testing/fixtures/fake-telegram.js';
import { seedUsers } from '../testing/fixtures/seed-users.js';
import { StubProvider, createStubProviderRegistry } from '../testing/fixtures/stub-llm-provider.js';

describe('compose-runtime settings registry wiring', () => {
	let tempDir: string;
	let runtime: Awaited<ReturnType<typeof composeRuntime>>;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-compose-settings-'));
		const logger = pino({ level: 'silent' });
		const seed = await seedUsers({ dataDir: tempDir, users: 2, households: 1 });

		const tempCostTracker = new CostTracker(join(tempDir, 'data'), logger);

		runtime = await composeRuntime({
			dataDir: join(tempDir, 'data'),
			configPath: seed.configPath,
			config: seed.config,
			providerRegistry: createStubProviderRegistry(tempCostTracker, logger),
			telegramService: fakeTelegramService(),
			logger,
		});

		const realCostTracker = runtime.services.costTracker as CostTracker;
		runtime.services.providerRegistry.register(new StubProvider(realCostTracker, logger));
	});

	afterAll(async () => {
		if (runtime) await runtime.dispose();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('SettingsRegistry is exposed on runtime.services', () => {
		expect(runtime.services.settingsRegistry).toBeDefined();
		expect(runtime.services.settingsRegistry).toBeInstanceOf(SettingsRegistry);
	});

	it('SettingsRegistry includes chatbot virtual keys', () => {
		const reg = runtime.services.settingsRegistry as SettingsRegistry;
		expect(reg.getByAppKey('chatbot', 'log_to_notes')).toBeDefined();
		expect(reg.getByAppKey('chatbot', 'session_search_tool_enabled')).toBeDefined();
	});

	it('SettingsRegistry does not double-register chatbot keys', () => {
		const reg = runtime.services.settingsRegistry as SettingsRegistry;
		const all = reg.getAll();
		const logToNotesDefs = all.filter((d) => d.appId === 'chatbot' && d.key === 'log_to_notes');
		expect(logToNotesDefs.length).toBe(1);

		const searchDefs = all.filter(
			(d) => d.appId === 'chatbot' && d.key === 'session_search_tool_enabled',
		);
		expect(searchDefs.length).toBe(1);
	});

	it('SettingsWriter is exposed on runtime.services', () => {
		expect(runtime.services.settingsWriter).toBeDefined();
		expect(runtime.services.settingsWriter).toBeInstanceOf(SettingsWriter);
	});

	it('SettingsWriter rejects unknown chatbot key', async () => {
		const writer = runtime.services.settingsWriter as SettingsWriter;
		const result = await writer.write({
			userId: 'u1',
			appId: 'chatbot',
			key: 'nonexistent_key',
			rawValue: 'true',
			source: 'nl',
		});
		expect(result.ok).toBe(false);
	});

	it('SettingsReader is wired and buildSettingsCatalog returns non-empty catalog (Task 3.7)', async () => {
		// The retrieval service is exposed on services via the index signature.
		const retrieval = runtime.services
			.conversationRetrievalService as ConversationRetrievalService;
		expect(retrieval).toBeDefined();

		// buildSettingsCatalog requires a requestContext with a userId.
		// user-0 is the admin user seeded by seedUsers({ users: 2, households: 1 }).
		const { catalog, trustedInstructions } = await requestContext.run(
			{ userId: 'user-0' },
			() => retrieval.buildSettingsCatalog(),
		);

		// The chatbot virtual manifest contributes at least log_to_notes,
		// flush_memory_on_idle_reset, and session_search_tool_enabled — so the
		// catalog must be non-empty.
		expect(catalog).toMatch(/## Your settings/);
		expect(catalog.length).toBeGreaterThan(0);

		// trustedInstructions should list the nlSafe keys with <config-set> syntax.
		expect(trustedInstructions).toMatch(/<config-set/);
	});
});
