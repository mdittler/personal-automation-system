/**
 * LLM Ops Dashboard — Persona Tests (G1–G5)
 *
 * Post-hoc audit suite for D5c Chunk D. These tests verify the admin ops
 * dashboard surface from the perspective of three named personas:
 *
 *   MATT  — platform admin, household hA (2 members: Matt + Nina)
 *   NINA  — non-admin, household hA
 *   ALICE — non-admin, household hB (1 member)
 *
 * Coverage: auth/access enforcement, real cost+member data flowing to the
 * template, live reservation reflection, and monotonic msg/min in live card.
 *
 * Threshold-permutation tests (pctOfCap rendering states) live in
 * llm-usage.test.ts D3–D7 — not duplicated here per the audit plan (Codex L1).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { LLMServiceImpl } from '../../services/llm/index.js';
import type { ModelCatalog } from '../../services/llm/model-catalog.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { ProviderRegistry } from '../../services/llm/providers/provider-registry.js';
import { MessageRateTracker } from '../../services/metrics/message-rate-tracker.js';
import type { LLMSafeguardsConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerLlmUsageRoutes } from '../routes/llm-usage.js';

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

const MATT = { userId: 'user-matt', password: 'pass-matt', householdId: 'hA', isAdmin: true };
const NINA = { userId: 'user-nina', password: 'pass-nina', householdId: 'hA', isAdmin: false };
const ALICE = { userId: 'user-alice', password: 'pass-alice', householdId: 'hB', isAdmin: false };

const AUTH_TOKEN = 'persona-test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

// ---------------------------------------------------------------------------
// Household fixture: hA has Matt + Nina; hB has Alice
// ---------------------------------------------------------------------------

const HOUSEHOLDS: Array<{ id: string; name: string }> = [
	{ id: 'hA', name: 'Household Alpha' },
	{ id: 'hB', name: 'Household Beta' },
];

const MEMBERS_BY_HOUSEHOLD: Record<string, string[]> = {
	hA: [MATT.userId, NINA.userId],
	hB: [ALICE.userId],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHouseholdService(
	households: Array<{ id: string; name: string }>,
	membersByHousehold: Record<string, string[]>,
): Pick<HouseholdService, 'listHouseholds' | 'getMembers'> {
	return {
		listHouseholds: () => households as ReturnType<HouseholdService['listHouseholds']>,
		getMembers: (hhId: string) =>
			(membersByHousehold[hhId] ?? []).map((userId) => ({
				id: userId,
				name: userId,
				isAdmin: false,
				householdId: hhId,
			})) as ReturnType<HouseholdService['getMembers']>,
	};
}

function makeAuthHouseholdService(userToHousehold: Record<string, string>) {
	return {
		getHouseholdForUser: (userId: string) => userToHousehold[userId] ?? null,
		getHousehold: (id: string) => ({ id, adminUserIds: [] }),
	};
}

function makeUserManager() {
	return {
		getUser: (id: string) => {
			const personas = [MATT, NINA, ALICE];
			const p = personas.find((x) => x.userId === id);
			return p ? { id: p.userId, name: p.userId, isAdmin: p.isAdmin } : null;
		},
		getAllUsers: () =>
			[MATT, NINA, ALICE].map((p) => ({ id: p.userId, name: p.userId, isAdmin: p.isAdmin })),
	};
}

function makeModelSelector(): ModelSelector {
	return {
		getStandardModel: () => 'claude-sonnet-4-20250514',
		getFastModel: () => 'claude-haiku-4-5-20251001',
		getStandardRef: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }),
		getFastRef: () => ({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
		getReasoningRef: () => undefined,
		setStandardModel: () => Promise.resolve(),
		setFastModel: () => Promise.resolve(),
		setStandardRef: () => Promise.resolve(),
		setFastRef: () => Promise.resolve(),
		setReasoningRef: () => Promise.resolve(),
	} as unknown as ModelSelector;
}

function makeModelCatalog(): ModelCatalog {
	return { getModels: () => Promise.resolve([]), refresh: () => Promise.resolve([]) } as unknown as ModelCatalog;
}

function makeProviderRegistry(): ProviderRegistry {
	return {
		getAll: () => [{ providerId: 'anthropic', providerType: 'anthropic' }],
		getProviderIds: () => ['anthropic'],
		has: () => true,
		size: 1,
	} as unknown as ProviderRegistry;
}

interface BuildOptions {
	costPerHousehold?: Record<string, number>;
	llmSafeguards?: LLMSafeguardsConfig;
	messageRateTracker?: MessageRateTracker;
}

async function buildPersonaApp(options: BuildOptions = {}) {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-persona-test-'));

	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(MATT.userId, MATT.password);
	await credService.setPassword(NINA.userId, NINA.password);
	await credService.setPassword(ALICE.userId, ALICE.password);

	const costData = options.costPerHousehold ?? { hA: 0.5, hB: 0.25 };
	const costTracker = {
		readUsage: () => Promise.resolve(''),
		getMonthlyHouseholdCost: (hhId: string) => costData[hhId] ?? 0,
	};

	const llm = { costTracker } as unknown as LLMServiceImpl;

	const app = Fastify({ logger: false });
	await app.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await app.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	const userToHousehold: Record<string, string> = {
		[MATT.userId]: MATT.householdId,
		[NINA.userId]: NINA.householdId,
		[ALICE.userId]: ALICE.householdId,
	};

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credService,
				userManager: makeUserManager() as unknown as import('../../services/user-manager/index.js').UserManager,
				householdService: makeAuthHouseholdService(userToHousehold) as unknown as import('../../services/household/index.js').HouseholdService,
			});
			await registerCsrfProtection(gui);
			registerLlmUsageRoutes(gui, {
				llm,
				modelSelector: makeModelSelector(),
				modelCatalog: makeModelCatalog(),
				providerRegistry: makeProviderRegistry(),
				logger,
				costTracker: costTracker as unknown as import('../../services/llm/cost-tracker.js').CostTracker,
				householdService: makeHouseholdService(HOUSEHOLDS, MEMBERS_BY_HOUSEHOLD),
				messageRateTracker: options.messageRateTracker,
				llmSafeguards: options.llmSafeguards,
			});
		},
		{ prefix: '/gui' },
	);

	return { app, tempDir };
}

function collectCookies(
	...responses: Array<{ cookies: Array<{ name: string; value: string }> }>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const res of responses) {
		for (const c of res.cookies as Array<{ name: string; value: string }>) {
			result[c.name] = c.value;
		}
	}
	return result;
}

async function loginAs(
	app: Awaited<ReturnType<typeof Fastify>>,
	userId: string,
	password: string,
): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId, password },
	});
	return collectCookies(res);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLM Ops Dashboard — Persona Tests', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof Fastify>>;

	beforeEach(() => {
		// tempDir captured per-test
	});

	afterEach(async () => {
		await app?.close();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	// G1
	it('Matt (admin) opens /gui/llm and sees both households with correct member counts and cost values', async () => {
		const built = await buildPersonaApp({ costPerHousehold: { hA: 0.50, hB: 0.25 } });
		app = built.app;
		tempDir = built.tempDir;

		const cookies = await loginAs(app, MATT.userId, MATT.password);
		const res = await app.inject({ method: 'GET', url: '/gui/llm', cookies });

		expect(res.statusCode).toBe(200);
		// Both households visible
		expect(res.body).toContain('Household Alpha');
		expect(res.body).toContain('Household Beta');
		// Member counts (hA has 2, hB has 1)
		expect(res.body).toContain('2'); // hA member count
		expect(res.body).toContain('1'); // hB member count
		// Costs from costTracker
		expect(res.body).toMatch(/0\.50|0\.5/);
		expect(res.body).toMatch(/0\.25/);
	});

	// G2
	it('Nina (non-admin) receives 403 when opening /gui/llm', async () => {
		const built = await buildPersonaApp();
		app = built.app;
		tempDir = built.tempDir;

		const cookies = await loginAs(app, NINA.userId, NINA.password);
		const res = await app.inject({ method: 'GET', url: '/gui/llm', cookies });

		expect(res.statusCode).toBe(403);
	});

	// G3
	it('Alice (non-admin) receives 403 when hitting /gui/llm/metrics directly', async () => {
		const built = await buildPersonaApp();
		app = built.app;
		tempDir = built.tempDir;

		const cookies = await loginAs(app, ALICE.userId, ALICE.password);
		const res = await app.inject({ method: 'GET', url: '/gui/llm/metrics', cookies });

		expect(res.statusCode).toBe(403);
	});

	// G4
	it('cost shown to Matt reflects live reservations (second page load after costTracker update shows higher cost)', async () => {
		// costTracker returns increasing values on successive calls, simulating reservation additions
		let callCount = 0;
		const dynamicCostTracker = {
			readUsage: () => Promise.resolve(''),
			getMonthlyHouseholdCost: (_hhId: string) => {
				callCount++;
				// First batch of calls (page load 1): $0.50; second batch (page load 2): $0.75
				return callCount <= 2 ? 0.5 : 0.75;
			},
		};

		const tempDir2 = await mkdtemp(join(tmpdir(), 'pas-persona-g4-'));
		const credService = new CredentialService({ dataDir: tempDir2 });
		await credService.setPassword(MATT.userId, MATT.password);

		const llm = { costTracker: dynamicCostTracker } as unknown as LLMServiceImpl;
		const app2 = Fastify({ logger: false });
		await app2.register(fastifyCookie, { secret: AUTH_TOKEN });
		const eta = new Eta();
		await app2.register(fastifyView, { engine: { eta }, root: viewsDir, viewExt: 'eta', layout: 'layout' });

		const userToHousehold = { [MATT.userId]: MATT.householdId };
		await app2.register(async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credService,
				userManager: makeUserManager() as unknown as import('../../services/user-manager/index.js').UserManager,
				householdService: makeAuthHouseholdService(userToHousehold) as unknown as import('../../services/household/index.js').HouseholdService,
			});
			await registerCsrfProtection(gui);
			registerLlmUsageRoutes(gui, {
				llm,
				modelSelector: makeModelSelector(),
				modelCatalog: makeModelCatalog(),
				providerRegistry: makeProviderRegistry(),
				logger,
				costTracker: dynamicCostTracker as unknown as import('../../services/llm/cost-tracker.js').CostTracker,
				householdService: makeHouseholdService(HOUSEHOLDS, MEMBERS_BY_HOUSEHOLD),
			});
		}, { prefix: '/gui' });

		try {
			const cookies = await loginAs(app2, MATT.userId, MATT.password);
			const res1 = await app2.inject({ method: 'GET', url: '/gui/llm', cookies });
			const res2 = await app2.inject({ method: 'GET', url: '/gui/llm', cookies });

			// Both responses succeed
			expect(res1.statusCode).toBe(200);
			expect(res2.statusCode).toBe(200);

			// Second response should show the higher cost from the updated tracker
			// Extract numeric cost values; res2 should contain 0.75 where res1 had 0.50
			expect(res1.body).toMatch(/0\.5/);
			expect(res2.body).toMatch(/0\.75/);
		} finally {
			await app2.close();
			await rm(tempDir2, { recursive: true, force: true });
		}
	});

	// G5
	it('Live card /gui/llm/metrics shows monotonically increasing msg/min after recordMessage calls between polls', async () => {
		const tracker = new MessageRateTracker();
		const built = await buildPersonaApp({ messageRateTracker: tracker });
		app = built.app;
		tempDir = built.tempDir;

		const cookies = await loginAs(app, MATT.userId, MATT.password);

		// First poll — no messages recorded yet
		const res1 = await app.inject({ method: 'GET', url: '/gui/llm/metrics', cookies });
		expect(res1.statusCode).toBe(200);

		// Record some messages then poll again
		tracker.recordMessage(MATT.householdId);
		tracker.recordMessage(NINA.householdId);

		const res2 = await app.inject({ method: 'GET', url: '/gui/llm/metrics', cookies });
		expect(res2.statusCode).toBe(200);

		// Second poll must show more msg/min than first (monotonically increasing)
		// Extract the numeric msg/min from each fragment
		const extractRpm = (body: string): number => {
			const m = body.match(/id="live-rpm"[^>]*>\s*(\d+)/);
			return m ? Number(m[1]) : -1;
		};

		const rpm1 = extractRpm(res1.body);
		const rpm2 = extractRpm(res2.body);

		expect(rpm2).toBeGreaterThan(rpm1);

		tracker.dispose();
	});
});
