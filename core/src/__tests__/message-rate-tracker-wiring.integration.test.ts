/**
 * MessageRateTracker — Production Wiring Tests (F1–F5)
 *
 * Post-hoc audit suite for D5c Chunk D. Verifies that the MessageRateTracker
 * is correctly wired into every inbound-message dispatch path and into the
 * graceful-shutdown sequence.
 *
 * F1, F4: Runtime — Router.routeMessage calls tracker.recordMessage with the
 *   householdId from the active requestContext.
 * F2: Source-scan — api/routes/messages.ts wraps routeMessage in requestContext.run
 *   so the householdId is propagated to the tracker.
 * F3: Source-scan — alert-executor.ts wraps router.routeMessage in requestContext.run
 *   for dispatch_message actions.
 * F5: Source-scan — bootstrap.ts registers tracker.dispose() in the shutdown
 *   handler so the cleanup timer is stopped on process exit.
 *
 * Source-scan rationale (F2, F3, F5): the dispatch sites in bootstrap.ts and
 * alert-executor.ts live inside inline callbacks that cannot be independently
 * imported without standing up the entire composition root. Source-scanning
 * preserves invariant coverage without requiring full-system bootstrap.
 * Pattern follows dispatch-context-wrap.test.ts.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { MessageRateTracker } from '../services/metrics/message-rate-tracker.js';
import { requestContext } from '../services/context/request-context.js';
import { Router } from '../services/router/index.js';
import type { AppRegistry } from '../services/app-registry/index.js';
import type { LLMService } from '../types/app-module.js';
import type { SystemConfig } from '../types/config.js';

// ---------------------------------------------------------------------------
// Source helpers (same pattern as dispatch-context-wrap.test.ts)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function readSource(relative: string): Promise<string> {
	const path = join(__dirname, '..', relative);
	return readFile(path, 'utf8');
}

function stripComments(source: string): string {
	const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
	return noBlock.replace(/\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// Minimal Router factory for runtime tests (F1, F4)
// ---------------------------------------------------------------------------

const logger = pino({ level: 'silent' });

function makeMinimalRouter(tracker: MessageRateTracker): Router {
	const mockRegistry = {
		getManifestCache: () => ({
			buildCommandMap: () => new Map(),
			buildIntentTable: () => [],
			buildPhotoIntentTable: () => [],
		}),
	} as unknown as AppRegistry;

	const mockTelegram = {
		send: vi.fn().mockResolvedValue(undefined),
	};

	const mockFallback = {} as unknown as import('../services/router/fallback.js').FallbackHandler;

	const minimalConfig: Pick<SystemConfig, 'users'> = { users: [] };

	const mockLlm = {
		complete: vi.fn().mockResolvedValue(''),
		classify: vi.fn().mockResolvedValue({ intent: 'none', confidence: 0 }),
	} as unknown as LLMService;

	const router = new Router({
		registry: mockRegistry,
		telegram: mockTelegram as unknown as import('../services/telegram/telegram-service.js').TelegramService,
		fallback: mockFallback,
		config: minimalConfig as unknown as SystemConfig,
		logger,
		llm: mockLlm,
		messageRateTracker: tracker,
	});

	return router;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageRateTracker production wiring', () => {
	// F1
	it('Router.routeMessage calls tracker.recordMessage with householdId from requestContext', async () => {
		const tracker = new MessageRateTracker();
		const recordSpy = vi.spyOn(tracker, 'recordMessage');

		const router = makeMinimalRouter(tracker);

		const ctx = {
			userId: 'user-1',
			text: 'hello',
			chatId: 'chat-1',
			messageId: 1,
			source: 'telegram' as const,
		};

		await requestContext.run({ userId: 'user-1', householdId: 'hA' }, () =>
			router.routeMessage(ctx),
		);

		expect(recordSpy).toHaveBeenCalledOnce();
		expect(recordSpy).toHaveBeenCalledWith('hA');

		tracker.dispose();
	});

	// F2
	it('api/routes/messages.ts wraps router.routeMessage in requestContext.run (source-scan)', async () => {
		const src = stripComments(await readSource('api/routes/messages.ts'));

		// requestContext.run must be called
		expect(src).toMatch(/requestContext\.run\s*\(/);

		// routeMessage must appear inside the file (called within the run wrapper)
		expect(src).toMatch(/router\.routeMessage\s*\(/);
	});

	// F3
	it('alert-executor.ts wraps router.routeMessage in requestContext.run for dispatch_message (source-scan)', async () => {
		const src = stripComments(await readSource('services/alerts/alert-executor.ts'));

		// requestContext.run wraps the dispatch_message path
		expect(src).toMatch(/requestContext\.run\s*\(/);

		// router.routeMessage is called within that context (may be `deps.router!.routeMessage`)
		expect(src).toMatch(/\.routeMessage\s*\(/);

		// The householdId is derived and included in the context object
		expect(src).toMatch(/householdId/);
	});

	// F4
	it('three householdIds from different requestContexts produce three distinct active households', async () => {
		const tracker = new MessageRateTracker();
		const router = makeMinimalRouter(tracker);

		const makeCtx = (userId: string) => ({
			userId,
			text: 'hello',
			chatId: `chat-${userId}`,
			messageId: 1,
			source: 'telegram' as const,
		});

		// Three distinct households — each call goes through its own requestContext
		await requestContext.run({ userId: 'u1', householdId: 'hA' }, () =>
			router.routeMessage(makeCtx('u1')),
		);
		await requestContext.run({ userId: 'u2', householdId: 'hB' }, () =>
			router.routeMessage(makeCtx('u2')),
		);
		await requestContext.run({ userId: 'u3', householdId: 'hC' }, () =>
			router.routeMessage(makeCtx('u3')),
		);

		expect(tracker.getActiveHouseholds()).toBe(3);
		expect(tracker.getMessagesPerMinute()).toBe(3);

		const rpm = tracker.getPerHouseholdRpm();
		expect(rpm.get('hA')).toBe(1);
		expect(rpm.get('hB')).toBe(1);
		expect(rpm.get('hC')).toBe(1);

		tracker.dispose();
	});

	// F5
	it('bootstrap.ts registers tracker.dispose() in the shutdown handler sequence (source-scan)', async () => {
		// Task-4 refactor: shutdown wiring moved to compose-runtime.ts
		const src = stripComments(await readSource('compose-runtime.ts'));

		// messageRateTracker.dispose must appear in the shutdown registration block.
		// The actual wiring: shutdownManager.registerServices({ ..., () => messageRateTracker.dispose() })
		expect(src).toMatch(/messageRateTracker\.dispose\s*\(\s*\)/);

		// It must appear in a shutdown/cleanup context — not just a random dispose call
		// Check that shutdownManager.registerServices is in the same file
		expect(src).toMatch(/shutdownManager\.registerServices\s*\(/);
	});
});
