/**
 * Persona tests — App-Message Memory Bridge end-to-end visibility.
 *
 * Round-1 §9 requirement: assert the actual `systemPrompt` STRING passed to
 * the LLM provider contains the bridged `[App: ...]` header AND a
 * recognizable body excerpt. Asserting on the stub's reply alone would be
 * meaningless — a stub returns the same text regardless of prompt content.
 *
 * Pattern (lifted from memory-snapshot-freeze.integration.test.ts):
 *   1. composeRuntime() builds a real chatbot stack.
 *   2. A RecordingStubProvider is registered AFTER composeRuntime so it can
 *      share the real CostTracker; it captures every `systemPrompt` that
 *      reaches the LLM.
 *   3. Each scenario seeds a synthetic bridged exchange via
 *      `runtime.services.appOutboundBridge.recordOutboundMessage(...)`.
 *   4. We then drive a follow-up user message through `router.routeMessage`
 *      and locate the chatbot completion's system prompt by its distinctive
 *      "You are a helpful" opening (see `prompt-builder.buildSystemPrompt`).
 *   5. Assertions verify the prompt contains the bridged header AND a
 *      verbatim excerpt of the bridged body.
 *
 * Scenarios:
 *   P1 — weekly-menu follow-up:   `[App: food] weekly-menu` + meal plan body
 *   P2 — report follow-up:        `[App: reports] report:weekly-spend` + line item
 *   P3 — alert follow-up:         `[App: alerts] alert:expiry-warning:telegram` + item
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeRuntime } from '../../../compose-runtime.js';
import { requestContext } from '../../context/request-context.js';
import { fakeTelegramService } from '../../../testing/fixtures/fake-telegram.js';
import { seedUsers } from '../../../testing/fixtures/seed-users.js';
import {
	StubProvider,
	createStubProviderRegistry,
} from '../../../testing/fixtures/stub-llm-provider.js';
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
} from '../../../types/llm.js';
import { CostTracker } from '../../llm/cost-tracker.js';
import type { Router } from '../../router/index.js';

const TIMEOUT_MS = 30_000;
const STUB_OPTIONS = { p50Ms: 1, p95Ms: 2, capMs: 5, completionText: 'OK' };

// ---------------------------------------------------------------------------
// RecordingStubProvider — captures every systemPrompt sent to the LLM.
// ---------------------------------------------------------------------------

class RecordingStubProvider extends StubProvider {
	readonly systemPrompts: string[] = [];

	protected override async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		if (options?.systemPrompt != null) {
			this.systemPrompts.push(options.systemPrompt as string);
		}
		return super.doComplete(prompt, options);
	}
}

// The chatbot system prompt is identified by its distinctive opening string,
// produced by `buildSystemPrompt`/`buildAppAwareSystemPrompt`. If this marker
// drifts, check `core/src/services/conversation/prompt-builder.ts`.
const CHATBOT_PROMPT_MARKER = 'You are a helpful';

function findChatbotPrompt(
	recorder: RecordingStubProvider,
	startIdx: number,
): string | undefined {
	return recorder.systemPrompts
		.slice(startIdx)
		.find((p) => p.includes(CHATBOT_PROMPT_MARKER));
}

// ---------------------------------------------------------------------------
// Shared composeRuntime fixture across all scenarios.
// ---------------------------------------------------------------------------

describe.sequential('App-Message Bridge persona tests', { timeout: TIMEOUT_MS }, () => {
	let tempDir = '';
	let runtime: Awaited<ReturnType<typeof composeRuntime>>;
	let recorder: RecordingStubProvider;
	let userA: { id: string; householdId: string };

	function getRouter(): Router {
		return runtime.services.router;
	}

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-bridge-persona-'));
		const logger = pino({ level: 'silent' });
		const seed = await seedUsers({ dataDir: tempDir, users: 2, households: 1 });
		userA = { id: seed.users[0]!.id, householdId: seed.users[0]!.householdId };

		const tempCostTracker = new CostTracker(join(tempDir, 'data'), logger);
		runtime = await composeRuntime({
			dataDir: join(tempDir, 'data'),
			configPath: seed.configPath,
			config: seed.config,
			providerRegistry: createStubProviderRegistry(tempCostTracker, logger, STUB_OPTIONS),
			telegramService: fakeTelegramService(),
			logger,
		});

		// Register the recorder AFTER composeRuntime so it shares the real CostTracker.
		// `register()` is keyed by providerId, so a second provider with the same id
		// 'stub' would be deduplicated. We bypass that by using the StubProvider's
		// existing test rewire path: replace the registry's stub provider in-place
		// via a re-register with a fresh class instance.
		recorder = new RecordingStubProvider(
			runtime.services.costTracker as CostTracker,
			logger,
			STUB_OPTIONS,
		);
		runtime.services.providerRegistry.register(recorder);
	}, TIMEOUT_MS);

	afterAll(async () => {
		if (runtime) {
			await (runtime.services.costTracker as CostTracker).drainWrites();
			await runtime.dispose();
		}
		if (tempDir) {
			await rm(tempDir, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		}
	}, TIMEOUT_MS);

	// ─── P1 — weekly-menu follow-up ──────────────────────────────────────────
	it('P1: bridged weekly-menu entry appears verbatim in chatbot systemPrompt', async () => {
		const userId = userA.id;
		const householdId = userA.householdId;
		const menuBody = 'Mon: Tacos, Tue: Stew, Wed: Pasta';

		// Seed the bridged exchange.
		await requestContext.run({ userId, householdId }, async () => {
			await runtime.services.appOutboundBridge.recordOutboundMessage({
				userId,
				appId: 'food',
				kind: 'weekly-menu',
				body: menuBody,
			});
		});

		// Drive a follow-up user message through the chatbot path.
		const startIdx = recorder.systemPrompts.length;
		await requestContext.run({ userId, householdId }, () =>
			getRouter().routeMessage({
				userId,
				text: 'what did you suggest for Tuesday?',
				chatId: 6001,
				messageId: 6001,
				timestamp: new Date(),
			}),
		);

		const prompt = findChatbotPrompt(recorder, startIdx);
		expect(prompt).toBeDefined();
		expect(prompt).toContain('[App: food] weekly-menu');
		expect(prompt).toContain('Mon: Tacos');
		expect(prompt).toContain('Tue: Stew');
	});

	// ─── P2 — report follow-up ───────────────────────────────────────────────
	it('P2: bridged report entry appears verbatim in chatbot systemPrompt', async () => {
		const userId = userA.id;
		const householdId = userA.householdId;
		const reportBody = 'Total: $123.45 — Produce $42.10, Meat $35.20';

		await requestContext.run({ userId, householdId }, async () => {
			await runtime.services.appOutboundBridge.recordOutboundMessage({
				userId,
				appId: 'reports',
				kind: 'report:weekly-spend',
				body: reportBody,
			});
		});

		const startIdx = recorder.systemPrompts.length;
		await requestContext.run({ userId, householdId }, () =>
			getRouter().routeMessage({
				userId,
				text: 'how much did I spend on produce?',
				chatId: 6010,
				messageId: 6010,
				timestamp: new Date(),
			}),
		);

		const prompt = findChatbotPrompt(recorder, startIdx);
		expect(prompt).toBeDefined();
		expect(prompt).toContain('[App: reports] report:weekly-spend');
		expect(prompt).toContain('Produce $42.10');
	});

	// ─── P3 — alert follow-up ────────────────────────────────────────────────
	it('P3: bridged alert entry appears verbatim in chatbot systemPrompt', async () => {
		const userId = userA.id;
		const householdId = userA.householdId;
		const alertBody = 'Item expiring: yogurt (best by 2026-05-20)';

		await requestContext.run({ userId, householdId }, async () => {
			await runtime.services.appOutboundBridge.recordOutboundMessage({
				userId,
				appId: 'alerts',
				kind: 'alert:expiry-warning:telegram',
				body: alertBody,
			});
		});

		const startIdx = recorder.systemPrompts.length;
		await requestContext.run({ userId, householdId }, () =>
			getRouter().routeMessage({
				userId,
				text: 'which item is expiring?',
				chatId: 6020,
				messageId: 6020,
				timestamp: new Date(),
			}),
		);

		const prompt = findChatbotPrompt(recorder, startIdx);
		expect(prompt).toBeDefined();
		expect(prompt).toContain('[App: alerts] alert:expiry-warning:telegram');
		expect(prompt).toContain('yogurt');
	});
});
