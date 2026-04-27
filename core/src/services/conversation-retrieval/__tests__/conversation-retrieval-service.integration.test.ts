/**
 * Integration tests for ConversationRetrievalServiceImpl.
 *
 * Uses real service implementations backed by a temp dir (real filesystem).
 * Verifies end-to-end wiring with:
 *   - ContextStoreServiceImpl (real I/O)
 *   - InteractionContextServiceImpl (in-memory)
 *   - requestContext ALS for userId isolation
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_INTERNAL_BYPASS, ContextStoreServiceImpl } from '../../context-store/index.js';
import { requestContext } from '../../context/request-context.js';
import { InteractionContextServiceImpl } from '../../interaction-context/index.js';
import {
	ConversationRetrievalServiceImpl,
	MissingRequestContextError,
} from '../conversation-retrieval-service.js';

// ─── Logger stub ──────────────────────────────────────────────────────────────

function makeLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

// ─── Two-user isolation ───────────────────────────────────────────────────────

describe('ConversationRetrievalServiceImpl integration — two-user isolation', () => {
	let tempDir: string;
	let contextStore: ContextStoreServiceImpl;
	let service: ConversationRetrievalServiceImpl;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pas-crs-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(tempDir, { recursive: true });

		contextStore = new ContextStoreServiceImpl({ dataDir: tempDir, logger: makeLogger() });

		service = new ConversationRetrievalServiceImpl({
			contextStore,
		});

		// Seed alice's context entry (bypass actor check — seeding outside a user request)
		await contextStore.save('alice', 'food-prefs', 'alice likes sushi', CONTEXT_INTERNAL_BYPASS);
		// Seed bob's context entry
		await contextStore.save('bob', 'food-prefs', 'bob likes tacos', CONTEXT_INTERNAL_BYPASS);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("alice's listContextEntries returns only alice's entries", async () => {
		const entries = await requestContext.run({ userId: 'alice' }, () =>
			service.listContextEntries(),
		);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((e) => e.content.includes('alice'))).toBe(true);
		expect(entries.some((e) => e.content.includes('bob'))).toBe(false);
	});

	it("bob's listContextEntries returns only bob's entries", async () => {
		const entries = await requestContext.run({ userId: 'bob' }, () => service.listContextEntries());
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((e) => e.content.includes('bob'))).toBe(true);
		expect(entries.some((e) => e.content.includes('alice'))).toBe(false);
	});

	it('parallel queries for alice and bob return isolated results', async () => {
		const [aliceEntries, bobEntries] = await Promise.all([
			requestContext.run({ userId: 'alice' }, () => service.listContextEntries()),
			requestContext.run({ userId: 'bob' }, () => service.listContextEntries()),
		]);

		expect(aliceEntries.some((e) => e.content.includes('alice'))).toBe(true);
		expect(aliceEntries.some((e) => e.content.includes('bob'))).toBe(false);

		expect(bobEntries.some((e) => e.content.includes('bob'))).toBe(true);
		expect(bobEntries.some((e) => e.content.includes('alice'))).toBe(false);
	});
});

// ─── Admin gate (buildSystemDataBlock) ───────────────────────────────────────

describe('ConversationRetrievalServiceImpl integration — admin gate', () => {
	/**
	 * Lightweight SystemInfoService stub: only methods used by gatherSystemData.
	 * Non-admin mode must not include safeguard defaults or per-app cost lines.
	 */
	function makeSystemInfo(isAdmin: boolean) {
		return {
			getTierAssignments: vi
				.fn()
				.mockReturnValue([{ tier: 'fast', provider: 'anthropic', model: 'claude-haiku-4' }]),
			getProviders: vi.fn().mockReturnValue([{ id: 'anthropic', type: 'anthropic' }]),
			getAvailableModels: vi.fn().mockResolvedValue([]),
			getModelPricing: vi.fn().mockReturnValue(null),
			getCostSummary: vi.fn().mockReturnValue({
				month: '2026-04',
				monthlyTotal: 5.5,
				perApp: { chatbot: 3.0, food: 2.5 },
				perUser: { alice: 3.0, bob: 2.5 },
			}),
			getScheduledJobs: vi.fn().mockReturnValue([]),
			getSystemStatus: vi.fn().mockReturnValue({
				uptimeSeconds: 7200,
				appCount: 2,
				userCount: isAdmin ? 2 : undefined,
				cronJobCount: 0,
				timezone: 'UTC',
			}),
			getSafeguardDefaults: vi.fn().mockReturnValue({
				rateLimit: { maxRequests: 20, windowSeconds: 60 },
				appMonthlyCostCap: 5,
				globalMonthlyCostCap: 50,
			}),
			isUserAdmin: vi.fn().mockReturnValue(isAdmin),
		};
	}

	it('non-admin: buildSystemDataBlock does not include admin-only sections', async () => {
		const systemInfo = makeSystemInfo(false);
		const service = new ConversationRetrievalServiceImpl({ systemInfo: systemInfo as never });

		const result = await requestContext.run({ userId: 'alice' }, () =>
			service.buildSystemDataBlock({ question: 'what is the system status?' }),
		);

		// Should include basic system status visible to all users
		expect(result).toContain('System status');
		// Should NOT include admin-only safeguard config
		expect(result).not.toContain('LLM safeguard defaults');
		// Should NOT include per-app cost breakdown
		expect(result).not.toContain('Per app:');
	});

	it('admin: buildSystemDataBlock includes admin-only safeguard defaults', async () => {
		const systemInfo = makeSystemInfo(true);
		const service = new ConversationRetrievalServiceImpl({ systemInfo: systemInfo as never });

		const result = await requestContext.run({ userId: 'alice' }, () =>
			service.buildSystemDataBlock({ question: 'what are the safeguard settings?' }),
		);

		// Admin sees safeguard config
		expect(result).toContain('LLM safeguard defaults');
	});
});

// ─── Missing dep graceful handling ────────────────────────────────────────────

describe('ConversationRetrievalServiceImpl integration — missing dep graceful handling', () => {
	it('searchData with no dataQuery dep throws dep-not-wired error', async () => {
		const service = new ConversationRetrievalServiceImpl({});

		await expect(
			requestContext.run({ userId: 'alice' }, () => service.searchData({ question: 'my recipes' })),
		).rejects.toThrow(/DataQueryService not wired/i);
	});

	it('listContextEntries with no contextStore dep throws dep-not-wired error', async () => {
		const service = new ConversationRetrievalServiceImpl({});

		await expect(
			requestContext.run({ userId: 'alice' }, () => service.listContextEntries()),
		).rejects.toThrow(/ContextStoreService not wired/i);
	});

	it('calling service outside requestContext throws MissingRequestContextError (not unhandled)', async () => {
		const service = new ConversationRetrievalServiceImpl({});

		// Calling without any requestContext.run wrapper — should throw a typed error
		await expect(service.listContextEntries()).rejects.toThrow(MissingRequestContextError);
	});
});

// ─── buildContextSnapshot partial fill ───────────────────────────────────────

describe('ConversationRetrievalServiceImpl integration — buildContextSnapshot partial fill', () => {
	let tempDir: string;
	let contextStore: ContextStoreServiceImpl;
	let interactionContext: InteractionContextServiceImpl;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pas-crs-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(tempDir, { recursive: true });

		contextStore = new ContextStoreServiceImpl({ dataDir: tempDir, logger: makeLogger() });
		interactionContext = new InteractionContextServiceImpl();

		// Seed a context entry for alice
		await contextStore.save('alice', 'diet-pref', 'vegetarian', CONTEXT_INTERNAL_BYPASS);

		// Seed a recent interaction for alice
		interactionContext.record('alice', { appId: 'food', action: 'view-recipe' });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('contextStore wired + dataQuery unwired: snapshot.contextStore is populated; data-query categories in failures', async () => {
		const service = new ConversationRetrievalServiceImpl({
			contextStore,
			interactionContext,
			// dataQuery intentionally omitted
		});

		const snapshot = await requestContext.run({ userId: 'alice' }, () =>
			service.buildContextSnapshot({
				question: 'test',
				mode: 'free-text',
				dataQueryCandidate: true, // Request data query even though dep is missing
				recentFilePaths: [],
			}),
		);

		// contextStore is wired and seeded — should appear in snapshot
		expect(snapshot.contextStore).toBeDefined();
		expect(snapshot.contextStore?.length).toBeGreaterThan(0);

		// dataQuery not wired — its categories should be in failures
		const dataQueryFailures = snapshot.failures.filter((f) =>
			['user-app-data', 'household-shared-data', 'space-data', 'collaboration-data'].includes(f),
		);
		expect(dataQueryFailures.length).toBeGreaterThan(0);
	});

	it('interactionContext wired: snapshot.interactionContext includes recent entries', async () => {
		const service = new ConversationRetrievalServiceImpl({
			contextStore,
			interactionContext,
		});

		const snapshot = await requestContext.run({ userId: 'alice' }, () =>
			service.buildContextSnapshot({
				question: 'hello',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
			}),
		);

		expect(snapshot.interactionContext).toBeDefined();
		expect(snapshot.interactionContext?.some((e) => e.appId === 'food')).toBe(true);
	});
});
