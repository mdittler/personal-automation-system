/**
 * Regression: test runs must not write shadow telemetry to the cwd data directory.
 *
 * Root cause (pre-fix): apps/food/src/index.ts init() wired FoodShadowLogger with
 * resolve(process.cwd(), 'data', 'system', 'food'), ignoring services.dataDir.
 * Tests that called init(services) without replacing shadow deps via
 * __setShadowDepsForTests contaminated the live data directory.
 *
 * Each case routes a message through the full init() + handleMessage() pipeline
 * WITHOUT replacing shadow deps afterward, then asserts the cwd-relative log file
 * was not created or modified.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { ScopedDataStore } from '@pas/core/types';

import { handleMessage, init } from '../../index.js';
import {
	__clearShadowDepsForTests,
	__flushShadowForTests,
} from '../shadow-integration.js';
import type { Household } from '../../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sampleHousehold: Household = {
	id: 'hh-isolation-test',
	name: 'Isolation Family',
	createdBy: 'user1',
	members: ['user1'],
	joinCode: 'ISO001',
	createdAt: '2026-01-01T00:00:00.000Z',
};

/** The path init() writes to before the fix (process.cwd()-relative). */
const CWD_DATA_LOG = resolve(process.cwd(), 'data', 'system', 'food', 'shadow-classifier-log.md');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getLogStat(): Promise<{ mtimeMs: number; size: number } | null> {
	try {
		const s = await stat(CWD_DATA_LOG);
		return { mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return null;
	}
}

function makeServices(dataDir: string, configOverrides?: Record<string, unknown>) {
	const store = createMockScopedStore();
	const userStore = createMockScopedStore();
	const services = { ...createMockCoreServices(), dataDir };

	// biome-ignore lint/suspicious/noExplicitAny: test mock type cast
	vi.mocked(services.data.forShared).mockReturnValue(store as any);
	// biome-ignore lint/suspicious/noExplicitAny: test mock type cast
	vi.mocked(services.data.forUser).mockReturnValue(userStore as any);
	vi.mocked(store.read).mockResolvedValue(stringify(sampleHousehold));
	vi.mocked(userStore.read).mockResolvedValue('');
	vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');
	vi.mocked(services.llm.classify).mockResolvedValue({ category: 'none', confidence: 0.1 });
	vi.mocked(services.llm.extractStructured).mockResolvedValue({});
	vi.mocked(services.config.get).mockImplementation(async (key: string) => {
		const overrides: Record<string, unknown> = {
			shadow_sample_rate: 1,
			routing_primary: 'regex',
			shadow_min_confidence: 0.7,
			...configOverrides,
		};
		return (overrides[key] ?? undefined) as never;
	});

	return services;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FoodShadowLogger isolation — init() must write shadow log to services.dataDir, not cwd', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'food-shadow-iso-'));
	});

	afterEach(async () => {
		await __flushShadowForTests();
		__clearShadowDepsForTests();
		await rm(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it('Case A: parse-failed path — shadow classify fires but result is not written to cwd', async () => {
		const before = await getLogStat();

		const services = makeServices(tempDir);
		await init(services);
		// Intentionally do NOT call __setShadowDepsForTests — let production logger run

		const ctx = createTestMessageContext({
			userId: 'user1',
			text: 'what recipes do I have',
		});
		await handleMessage(ctx, services);
		await __flushShadowForTests();

		const after = await getLogStat();
		// cwd-relative log must be unchanged (neither created nor appended to)
		expect(after?.mtimeMs ?? null).toBe(before?.mtimeMs ?? null);
		expect(after?.size ?? null).toBe(before?.size ?? null);
	});

	it('Case B: legacy-skipped path — dispatchByRoute win does not write to cwd', async () => {
		const before = await getLogStat();

		const services = makeServices(tempDir);
		await init(services);

		const ctx = createTestMessageContext({
			userId: 'user1',
			text: 'generate a meal plan',
			route: {
				appId: 'food',
				intent: 'user wants to generate a meal plan',
				confidence: 0.95,
				source: 'intent',
				verifierStatus: 'agreed',
			},
		});
		await handleMessage(ctx, services);
		await __flushShadowForTests();

		const after = await getLogStat();
		expect(after?.mtimeMs ?? null).toBe(before?.mtimeMs ?? null);
		expect(after?.size ?? null).toBe(before?.size ?? null);
	});

	it('Case C: skipped-sample path — sample_rate=0 does not write to cwd', async () => {
		const before = await getLogStat();

		const services = makeServices(tempDir, { shadow_sample_rate: 0 });
		await init(services);

		const ctx = createTestMessageContext({
			userId: 'user1',
			text: 'what is in my pantry',
		});
		await handleMessage(ctx, services);
		await __flushShadowForTests();

		const after = await getLogStat();
		expect(after?.mtimeMs ?? null).toBe(before?.mtimeMs ?? null);
		expect(after?.size ?? null).toBe(before?.size ?? null);
	});
});
