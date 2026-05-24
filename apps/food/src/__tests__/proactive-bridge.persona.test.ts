/**
 * Persona tests — Food proactive bridge → chatbot visibility.
 *
 * Proves Gus (the chatbot) can actually answer natural follow-up questions
 * about a proactive Food message. The mechanism under test:
 *
 *   1. A scheduled Food job (e.g. `nightly-rating-prompt`) fires.
 *   2. The job sends a Telegram message AND records a synthetic
 *      `[App: food] <kind>` user-turn + assistant-body pair into the
 *      conversation transcript via the REAL `AppOutboundBridge`.
 *   3. Later, the user sends a natural follow-up. The chatbot fallback
 *      loads recent turns and builds a system prompt that includes those
 *      bridged turns in the conversation-history section.
 *
 * Asserting on the built system prompt (not a stubbed LLM reply) is what
 * makes this load-bearing: a stubbed LLM returns whatever we tell it to,
 * but the production prompt-builder produces a real string we can read.
 *
 * Pattern mirrors:
 *   core/src/services/conversation/__tests__/app-message-bridge.persona.test.ts
 *
 * The "capture method" here is a DIRECT invocation of `buildSystemPrompt`
 * (the same function the chatbot fallback calls — see
 * `core/src/services/conversation/handle-message.ts` line ~254/262). The
 * loaded `turns` come from the same `chatSessions.loadRecentTurns` call
 * the production code uses. This avoids spinning up `composeRuntime` for a
 * Food-app integration test and keeps the assertion focused on what the
 * model actually sees.
 *
 * Scenarios (6 positive + 1 negative):
 *   P1 — nightly-rating-prompt
 *   P2 — perishable-check
 *   P3 — leftover-check
 *   P4 — freezer-check
 *   P5 — seasonal-nudge
 *   P6 — cultural-calendar-check  (kind: cultural-calendar)
 *   N1 — app_message_bridge_enabled=false: no [App: food] in prompt
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createAppOutboundBridge } from '../../../../core/src/services/app-outbound-bridge/index.js';
import type { AppOutboundBridge } from '../../../../core/src/services/app-outbound-bridge/index.js';
import type { ChatSessionStore } from '../../../../core/src/services/conversation-session/chat-session-store.js';
import { composeChatSessionStore } from '../../../../core/src/services/conversation-session/compose.js';
import { buildSessionKey } from '../../../../core/src/services/conversation-session/session-key.js';
import { CONVERSATION_DATA_SCOPES } from '../../../../core/src/services/conversation/manifest.js';
import { buildSystemPrompt } from '../../../../core/src/services/conversation/prompt-builder.js';
import { ChangeLog } from '../../../../core/src/services/data-store/change-log.js';
import { DataStoreServiceImpl } from '../../../../core/src/services/data-store/index.js';
import type { AppLogger } from '../../../../core/src/types/app-module.js';
import type { AppConfigService } from '../../../../core/src/types/config.js';
import type { LLMService } from '../../../../core/src/types/llm.js';
import type {
	CulturalCalendar,
	FreezerItem,
	Household,
	Leftover,
	MealPlan,
	PantryItem,
} from '../types.js';

// ── Mocks (top-level, hoisted) ───────────────────────────────────────────────

vi.mock('../services/meal-planner.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../services/meal-planner.js')>();
	return { ...original, generatePlan: vi.fn() };
});

vi.mock('../services/batch-cooking.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../services/batch-cooking.js')>();
	return { ...original, analyzeBatchPrep: vi.fn() };
});

const { handleScheduledJob, init } = await import('../index.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'hh1',
		name: 'Solo Family',
		createdBy: 'user1',
		members: ['user1'],
		joinCode: 'ABC123',
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

/** Minimal AppLogger stub for buildSystemPrompt. */
function silentAppLogger(): AppLogger {
	const noop = () => {};
	const logger: AppLogger = {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		child: () => logger,
	};
	return logger;
}

/** Minimal LLMService stub for buildSystemPrompt (only needs getModelForTier). */
function stubLlmService(): LLMService {
	return {
		getModelForTier: (tier: string) => `stub-${tier}-model`,
	} as unknown as LLMService;
}

interface BridgeEnv {
	tempDir: string;
	chatSessions: ChatSessionStore;
	bridge: AppOutboundBridge;
	conversationConfig: AppConfigService;
	bridgeEnabled: { value: boolean };
	teardown(): Promise<void>;
}

async function makeBridgeEnv(): Promise<BridgeEnv> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-food-bridge-persona-'));
	const logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;

	const dataService = new DataStoreServiceImpl({
		dataDir: tempDir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog: new ChangeLog(tempDir),
	});

	const chatSessions = composeChatSessionStore({ data: dataService, logger });

	// Mutable opt-out flag so the negative scenario can flip it without
	// rebuilding the bridge. Defaults: opt-out is OFF (bridge enabled).
	const bridgeEnabled = { value: true };
	const conversationConfig: AppConfigService = {
		get: vi.fn().mockResolvedValue(undefined),
		getAll: vi.fn().mockImplementation(async () => {
			return bridgeEnabled.value ? {} : { app_message_bridge_enabled: false };
		}),
		getOverrides: vi.fn().mockResolvedValue(null),
		setAll: vi.fn().mockResolvedValue(undefined),
		updateOverrides: vi.fn().mockResolvedValue(undefined),
		removeOverride: vi.fn().mockResolvedValue(undefined),
	} as unknown as AppConfigService;

	const bridge = createAppOutboundBridge({
		chatSessions,
		conversationConfig,
		logger,
	});

	return {
		tempDir,
		chatSessions,
		bridge,
		conversationConfig,
		bridgeEnabled,
		teardown: () => rm(tempDir, { recursive: true, force: true }),
	};
}

/**
 * Load the recent turns the chatbot fallback would see for `userId` and build
 * the same `buildSystemPrompt` string the production handler builds for a
 * non-PAS message. Returns the captured prompt string.
 *
 * Mirrors handle-message.ts:254-260 — `auto_detect_pas` off (or off-path
 * classification) calls `buildSystemPrompt([], turns, deps, { ... })`.
 */
async function captureChatbotSystemPrompt(
	chatSessions: ChatSessionStore,
	userId: string,
): Promise<string> {
	const sessionKey = buildSessionKey({
		agent: 'main',
		channel: 'telegram',
		scope: 'dm',
		chatId: userId,
	});
	const turns = await chatSessions.loadRecentTurns({ userId, sessionKey }, { maxTurns: 20 });
	return buildSystemPrompt([], turns, {
		llm: stubLlmService(),
		logger: silentAppLogger(),
	});
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Food proactive bridge — chatbot visibility (persona)', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;
	let userStore: ReturnType<typeof createMockScopedStore>;
	let env: BridgeEnv;

	beforeEach(async () => {
		sharedStore = createMockScopedStore();
		userStore = createMockScopedStore();
		services = createMockCoreServices();
		env = await makeBridgeEnv();
		(services as { appOutboundBridge?: unknown }).appOutboundBridge = env.bridge;
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as unknown as ScopedDataStore);
		vi.mocked(services.data.forUser).mockReturnValue(userStore as unknown as ScopedDataStore);
		await init(services);
	});

	afterEach(async () => {
		await env.teardown();
		vi.useRealTimers();
	});

	describe('Gus can see bridged proactive Food messages in his system prompt', () => {
		it('P1: nightly-rating-prompt — system prompt contains kind header + meal name', async () => {
			const today = '2026-04-15';
			const plan: MealPlan = {
				id: 'plan-001',
				startDate: '2026-04-13',
				endDate: '2026-04-19',
				meals: [
					{
						recipeId: 'r1',
						recipeTitle: 'Chicken Dinner',
						date: today,
						mealType: 'dinner',
						votes: {},
						cooked: false,
						rated: false,
						isNew: false,
					},
				],
				status: 'active',
				createdAt: '2026-04-12T00:00:00.000Z',
				updatedAt: '2026-04-12T00:00:00.000Z',
			};
			sharedStore.read.mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(makeHousehold({ members: ['user1'] }));
				if (path === 'meal-plans/current.yaml') return stringify(plan);
				return '';
			});
			(services as { timezone?: string }).timezone = 'UTC';
			vi.useFakeTimers();
			vi.setSystemTime(new Date(`${today}T20:00:00Z`));

			await handleScheduledJob?.('nightly-rating-prompt', undefined);

			// Sanity: bridged turn-pair landed in transcript.
			const sessionKey = buildSessionKey({
				agent: 'main',
				channel: 'telegram',
				scope: 'dm',
				chatId: 'user1',
			});
			const turns = await env.chatSessions.loadRecentTurns(
				{ userId: 'user1', sessionKey },
				{ maxTurns: 20 },
			);
			expect(turns.length).toBeGreaterThanOrEqual(2);
			expect(turns.at(-2)?.content).toBe('[App: food] nightly-rating-prompt');

			// User sends a natural follow-up; capture the chatbot system prompt.
			// (`captureChatbotSystemPrompt` ignores the follow-up text — production
			// only uses it for classification/sanitization, not for prompt-building.)
			const prompt = await captureChatbotSystemPrompt(env.chatSessions, 'user1');
			expect(prompt).toContain('[App: food] nightly-rating-prompt');
			expect(prompt).toContain('Chicken Dinner');
		});

		it('P2: perishable-check — system prompt contains kind header + item name', async () => {
			const pantry: PantryItem[] = [
				{
					name: 'Spinach',
					quantity: '1 bag',
					addedDate: '2026-04-10',
					category: 'produce',
					expiryEstimate: '2026-04-15',
				},
			];
			sharedStore.read.mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(makeHousehold({ members: ['user1'] }));
				if (path === 'pantry.yaml') return stringify(pantry);
				return '';
			});
			(services as { timezone?: string }).timezone = 'UTC';
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-04-14T09:00:00Z'));

			await handleScheduledJob?.('perishable-check', undefined);

			const prompt = await captureChatbotSystemPrompt(env.chatSessions, 'user1');
			expect(prompt).toContain('[App: food] perishable-check');
			expect(prompt).toContain('Spinach');
		});

		it('P3: leftover-check — system prompt contains kind header + leftover name', async () => {
			const today = '2026-04-15';
			const leftovers: Leftover[] = [
				{
					name: 'Pasta',
					quantity: '2 servings',
					storedDate: '2026-04-13',
					expiryEstimate: today,
					status: 'active',
				},
			];
			sharedStore.read.mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(makeHousehold({ members: ['user1'] }));
				if (path === 'leftovers.yaml') return stringify({ items: leftovers });
				return '';
			});
			(services as { timezone?: string }).timezone = 'UTC';
			vi.useFakeTimers();
			vi.setSystemTime(new Date(`${today}T10:00:00Z`));

			await handleScheduledJob?.('leftover-check', undefined);

			const prompt = await captureChatbotSystemPrompt(env.chatSessions, 'user1');
			expect(prompt).toContain('[App: food] leftover-check');
			expect(prompt).toContain('Pasta');
		});

		it('P4: freezer-check — system prompt contains kind header + freezer item', async () => {
			const today = '2026-06-30';
			const items: FreezerItem[] = [
				{ name: 'Old Chicken', quantity: '1 lb', frozenDate: '2026-01-01', source: 'purchased' },
			];
			sharedStore.read.mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(makeHousehold({ members: ['user1'] }));
				if (path === 'freezer.yaml') return stringify({ items });
				return '';
			});
			(services as { timezone?: string }).timezone = 'UTC';
			vi.useFakeTimers();
			vi.setSystemTime(new Date(`${today}T09:00:00Z`));

			await handleScheduledJob?.('freezer-check', undefined);

			const prompt = await captureChatbotSystemPrompt(env.chatSessions, 'user1');
			expect(prompt).toContain('[App: food] freezer-check');
			expect(prompt).toContain('Old Chicken');
		});

		it('P5: seasonal-nudge — system prompt contains kind header + suggested produce', async () => {
			sharedStore.read.mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(makeHousehold({ members: ['user1'] }));
				return '';
			});
			vi.mocked(services.llm.complete).mockResolvedValue(
				'Try strawberries — in season now! Strawberry salad is delicious.',
			);

			await handleScheduledJob?.('seasonal-nudge', undefined);

			const prompt = await captureChatbotSystemPrompt(env.chatSessions, 'user1');
			expect(prompt).toContain('[App: food] seasonal-nudge');
			expect(prompt).toContain('strawberries');
		});

		it('P6: cultural-calendar-check — system prompt contains kind header + holiday name', async () => {
			const calendar: CulturalCalendar = {
				holidays: [
					{
						id: 'christmas',
						name: 'Christmas',
						dateRule: { type: 'fixed', month: 12, day: 25 },
						cuisine: 'American',
						traditionalFoods: ['roast turkey', 'glazed ham'],
						region: 'US',
						enabled: true,
					},
				],
			};
			sharedStore.read.mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(makeHousehold({ members: ['user1'] }));
				if (path === 'cultural-calendar.yaml') return stringify(calendar);
				return '';
			});
			sharedStore.list.mockResolvedValue([]);
			vi.mocked(services.llm.complete).mockResolvedValue(
				'Christmas is coming — try our roast turkey!',
			);
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-12-15T10:00:00Z'));

			await handleScheduledJob?.('cultural-calendar-check', undefined);

			const prompt = await captureChatbotSystemPrompt(env.chatSessions, 'user1');
			expect(prompt).toContain('[App: food] cultural-calendar');
			expect(prompt).toContain('Christmas');
		});
	});

	it('N1: with app_message_bridge_enabled=false, the system prompt contains no [App: food] turn', async () => {
		// Flip the opt-out BEFORE the job fires so the bridge records nothing.
		env.bridgeEnabled.value = false;

		// Drive a job that would otherwise bridge — reuse the seasonal-nudge
		// fixture (no time-sensitivity, no real data needed beyond household +
		// an LLM-mocked body).
		sharedStore.read.mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(makeHousehold({ members: ['user1'] }));
			return '';
		});
		vi.mocked(services.llm.complete).mockResolvedValue(
			'Try strawberries — in season now! Strawberry salad is delicious.',
		);

		await handleScheduledJob?.('seasonal-nudge', undefined);

		// Telegram still fires (opt-out only suppresses the bridge record, not the
		// proactive send), but the transcript should be empty.
		expect(services.telegram.send).toHaveBeenCalled();

		const prompt = await captureChatbotSystemPrompt(env.chatSessions, 'user1');
		expect(prompt).not.toContain('[App: food]');
		expect(prompt).not.toContain('seasonal-nudge');
	});
});
