import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { LLMServiceImpl } from '../../services/llm/index.js';
import type { CatalogModel, ModelCatalog } from '../../services/llm/model-catalog.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { ProviderRegistry } from '../../services/llm/providers/provider-registry.js';
import { MessageRateTracker } from '../../services/metrics/message-rate-tracker.js';
import type { LLMSafeguardsConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { escapeHtml, parseUsageMarkdown, registerLlmUsageRoutes } from '../routes/llm-usage.js';

const AUTH_TOKEN = 'test-token';
const TEST_USER_ID = '123';
const TEST_PASSWORD = 'test-password';
const NON_ADMIN_USER_ID = '456';
const NON_ADMIN_PASSWORD = 'non-admin-password';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

function makeUserManager(users: Array<{ id: string; name: string; isAdmin: boolean }>) {
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users as ReadonlyArray<{ id: string; name: string; isAdmin: boolean }>,
	};
}

function makeHouseholdService(
	userToHousehold: Record<string, string>,
	households: Array<{ id: string; adminUserIds: string[] }>,
) {
	return {
		getHouseholdForUser: (userId: string) => userToHousehold[userId] ?? null,
		getHousehold: (id: string) => households.find((h) => h.id === id) ?? null,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModelSelector() {
	return {
		getStandardModel: () => 'claude-sonnet-4-20250514',
		getFastModel: () => 'claude-haiku-4-5-20251001',
		getStandardRef: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }),
		getFastRef: () => ({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
		getReasoningRef: () => undefined,
		setStandardModel: vi.fn().mockResolvedValue(undefined),
		setFastModel: vi.fn().mockResolvedValue(undefined),
		setStandardRef: vi.fn().mockResolvedValue(undefined),
		setFastRef: vi.fn().mockResolvedValue(undefined),
		setReasoningRef: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModelSelector;
}

function createMockProviderRegistry(providers: Array<{ id: string; type: string }> = []) {
	return {
		getAll: () =>
			providers.map((p) => ({
				providerId: p.id,
				providerType: p.type,
			})),
		getProviderIds: () => providers.map((p) => p.id),
		has: (id: string) => providers.some((p) => p.id === id),
		size: providers.length,
	} as unknown as ProviderRegistry;
}

function createMockCatalog(models: CatalogModel[] = []) {
	return {
		getModels: vi.fn().mockResolvedValue(models),
		refresh: vi.fn().mockResolvedValue(models),
	} as unknown as ModelCatalog;
}

async function buildApp(options?: {
	modelSelector?: ModelSelector;
	providerRegistry?: ProviderRegistry;
	modelCatalog?: ModelCatalog;
	usageContent?: string;
	tempDir?: string;
	// Chunk D extensions
	monthlyCostTracker?: Pick<import('../../services/llm/cost-tracker.js').CostTracker, 'getMonthlyHouseholdCost'>;
	householdServiceFull?: Pick<HouseholdService, 'listHouseholds' | 'getMembers'>;
	messageRateTracker?: MessageRateTracker;
	llmSafeguards?: LLMSafeguardsConfig;
}) {
	const modelSelector = options?.modelSelector ?? createMockModelSelector();
	const providerRegistry =
		options?.providerRegistry ??
		createMockProviderRegistry([{ id: 'anthropic', type: 'anthropic' }]);
	const modelCatalog = options?.modelCatalog ?? createMockCatalog();
	const usageContent = options?.usageContent ?? '';
	const tempDir = options?.tempDir ?? (await mkdtemp(join(tmpdir(), 'pas-llm-test-')));

	const costTracker = { readUsage: vi.fn().mockResolvedValue(usageContent) };
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

	// D5b-4: wire per-user auth so requirePlatformAdmin can inspect request.user
	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(TEST_USER_ID, TEST_PASSWORD);
	await credService.setPassword(NON_ADMIN_USER_ID, NON_ADMIN_PASSWORD);
	const userManager = makeUserManager([
		{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true },
		{ id: NON_ADMIN_USER_ID, name: 'NonAdmin', isAdmin: false },
	]);
	const householdService = makeHouseholdService(
		{ [TEST_USER_ID]: 'hh-1', [NON_ADMIN_USER_ID]: 'hh-1' },
		[{ id: 'hh-1', adminUserIds: [TEST_USER_ID] }],
	);

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credService,
				userManager: userManager as unknown as import('../../services/user-manager/index.js').UserManager,
				householdService: householdService as unknown as import('../../services/household/index.js').HouseholdService,
			});
			await registerCsrfProtection(gui);
			registerLlmUsageRoutes(gui, {
				llm,
				modelSelector,
				modelCatalog,
				providerRegistry,
				logger,
				costTracker: options?.monthlyCostTracker as unknown as import('../../services/llm/cost-tracker.js').CostTracker,
				householdService: options?.householdServiceFull,
				messageRateTracker: options?.messageRateTracker,
				llmSafeguards: options?.llmSafeguards,
			});
		},
		{ prefix: '/gui' },
	);

	return { app, modelSelector, providerRegistry, modelCatalog, tempDir };
}

function makeLlmHouseholdService(
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

async function authenticatedGet(app: Awaited<ReturnType<typeof Fastify>>, url: string) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
	});
	const cookies = collectCookies(loginRes);
	return app.inject({ method: 'GET', url, cookies });
}

async function authenticatedPost(
	app: Awaited<ReturnType<typeof Fastify>>,
	url: string,
	payload: Record<string, unknown>,
) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
	});
	const loginCookies = collectCookies(loginRes);

	const getRes = await app.inject({
		method: 'GET',
		url: '/gui/llm',
		cookies: loginCookies,
	});
	const allCookies = collectCookies(loginRes, getRes);

	const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';

	return app.inject({
		method: 'POST',
		url,
		payload: { ...payload, _csrf: csrfToken },
		cookies: allCookies,
	});
}

async function authenticatedGetAs(
	app: Awaited<ReturnType<typeof Fastify>>,
	userId: string,
	password: string,
	url: string,
) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId, password },
	});
	const cookies = collectCookies(loginRes);
	return app.inject({ method: 'GET', url, cookies });
}

// ---------------------------------------------------------------------------
// Unit tests: parseUsageMarkdown
// ---------------------------------------------------------------------------

describe('parseUsageMarkdown', () => {
	it('parses 7-column format correctly', () => {
		const content = [
			'# LLM Usage Log',
			'',
			'| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App |',
			'|-----------|----------|-------|-------------|---------------|----------|-----|',
			'| 2026-03-11T10:00:00Z | anthropic | claude-sonnet-4-20250514 | 100 | 50 | 0.000450 | echo |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].provider).toBe('anthropic');
		expect(result.rows[0].model).toBe('claude-sonnet-4-20250514');
		expect(result.rows[0].app).toBe('echo');
		expect(result.perModel).toHaveLength(1);
		expect(result.perModel[0].provider).toBe('anthropic');
	});

	it('parses 6-column format (backward compat)', () => {
		const content = [
			'| Timestamp | Model | Input Tokens | Output Tokens | Cost ($) | App |',
			'|-----------|-------|-------------|---------------|----------|-----|',
			'| 2026-03-11T10:00:00Z | claude-sonnet-4-20250514 | 100 | 50 | 0.000450 | echo |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].provider).toBe('-');
		expect(result.rows[0].model).toBe('claude-sonnet-4-20250514');
	});

	it('returns zeros for empty input', () => {
		const result = parseUsageMarkdown('');

		expect(result.rows).toHaveLength(0);
		expect(result.todayCost).toBe(0);
		expect(result.monthCost).toBe(0);
		expect(result.totalCost).toBe(0);
		expect(result.perModel).toHaveLength(0);
	});

	it('skips malformed rows with fewer than 6 columns', () => {
		const content = [
			'| Timestamp | Model |',
			'|-----------|-------|',
			'| 2026-03-11 | incomplete |',
			'| 2026-03-11T10:00:00Z | anthropic | claude-sonnet-4-20250514 | 100 | 50 | 0.000450 | echo |',
		].join('\n');

		const result = parseUsageMarkdown(content);
		expect(result.rows).toHaveLength(1);
	});

	it('handles non-numeric cost/token values gracefully', () => {
		const content = '| 2026-03-11T10:00:00Z | anthropic | model | abc | def | ghi | app |';

		const result = parseUsageMarkdown(content);
		expect(result.rows).toHaveLength(1);
		expect(result.totalCost).toBe(0);
	});

	it('aggregates per-model correctly across multiple rows', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo |',
			'| 2026-03-11T11:00:00Z | anthropic | sonnet | 200 | 100 | 0.002 | echo |',
			'| 2026-03-11T12:00:00Z | google | gemini | 300 | 150 | 0.003 | app2 |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.perModel).toHaveLength(2);
		const sonnet = result.perModel.find((m) => m.model === 'sonnet');
		expect(sonnet).toBeDefined();
		expect(sonnet?.callCount).toBe(2);
		expect(sonnet?.totalInputTokens).toBe(300);
		expect(sonnet?.totalOutputTokens).toBe(150);
		expect(sonnet?.totalCost).toBeCloseTo(0.003, 6);
	});

	it('computes today/month costs based on timestamps', () => {
		const today = new Date().toISOString().slice(0, 10);
		const thisMonth = new Date().toISOString().slice(0, 7);
		const lastYear = '2020-01-15T10:00:00Z';

		const content = [
			`| ${today}T10:00:00Z | anthropic | model | 100 | 50 | 1.000000 | app |`,
			`| ${thisMonth}-01T10:00:00Z | anthropic | model | 100 | 50 | 2.000000 | app |`,
			`| ${lastYear} | anthropic | model | 100 | 50 | 3.000000 | app |`,
		].join('\n');

		const result = parseUsageMarkdown(content);

		// Today's row also matches thisMonth
		expect(result.todayCost).toBeCloseTo(1.0, 6);
		expect(result.monthCost).toBeCloseTo(3.0, 6); // both rows in this month
		expect(result.totalCost).toBeCloseTo(6.0, 6);
	});

	it('keys per-model by provider:model (same model ID, different providers)', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | model-x | 100 | 50 | 0.001 | app |',
			'| 2026-03-11T11:00:00Z | google | model-x | 200 | 100 | 0.002 | app |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.perModel).toHaveLength(2);
		expect(result.perModel.map((m) => m.provider).sort()).toEqual(['anthropic', 'google']);
	});

	it('rounds accumulated costs to 6 decimal places (D11)', () => {
		// Use values that cause floating-point drift: 0.1 + 0.2 !== 0.3 in IEEE 754
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | model | 100 | 50 | 0.100000 | app |',
			'| 2026-03-11T11:00:00Z | anthropic | model | 100 | 50 | 0.200000 | app |',
			'| 2026-03-11T12:00:00Z | anthropic | model | 100 | 50 | 0.000001 | app |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		// Without rounding, 0.1 + 0.2 would be 0.30000000000000004
		expect(result.totalCost.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
		expect(result.totalCost).toBe(0.300001);
	});

	it('rounds per-model breakdown costs to 6 decimal places (D11)', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | model | 100 | 50 | 0.100000 | app |',
			'| 2026-03-11T11:00:00Z | anthropic | model | 100 | 50 | 0.200000 | app |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		const breakdown = result.perModel[0];
		expect(breakdown.totalCost.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
	});

	it('returns rows in reverse chronological order', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | model | 100 | 50 | 0.001 | first |',
			'| 2026-03-11T12:00:00Z | anthropic | model | 100 | 50 | 0.001 | second |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.rows[0].app).toBe('second');
		expect(result.rows[1].app).toBe('first');
	});

	it('parses 8-column format with user', () => {
		const content = [
			'| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App | User |',
			'|-----------|----------|-------|-------------|---------------|----------|-----|------|',
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | user123 |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].user).toBe('user123');
		expect(result.rows[0].provider).toBe('anthropic');
	});

	it('defaults user to - when 7-column format', () => {
		const content = '| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo |';

		const result = parseUsageMarkdown(content);

		expect(result.rows[0].user).toBe('-');
	});

	it('aggregates per-user costs', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice |',
			'| 2026-03-11T11:00:00Z | anthropic | sonnet | 200 | 100 | 0.002 | echo | alice |',
			'| 2026-03-11T12:00:00Z | anthropic | sonnet | 100 | 50 | 0.003 | echo | bob |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.perUser).toHaveLength(2);
		const alice = result.perUser.find((u) => u.userId === 'alice');
		expect(alice).toBeDefined();
		expect(alice?.callCount).toBe(2);
		expect(alice?.totalCost).toBeCloseTo(0.003, 6);
		const bob = result.perUser.find((u) => u.userId === 'bob');
		expect(bob?.callCount).toBe(1);
	});

	it('excludes - user from per-user aggregation', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | - |',
			'| 2026-03-11T11:00:00Z | anthropic | sonnet | 100 | 50 | 0.002 | echo | alice |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.perUser).toHaveLength(1);
		expect(result.perUser[0].userId).toBe('alice');
	});

	it('returns empty perUser for content without user column', () => {
		const content = '| 2026-03-11T10:00:00Z | anthropic | model | 100 | 50 | 0.001 | app |';

		const result = parseUsageMarkdown(content);

		expect(result.perUser).toHaveLength(0);
	});

	it('parses 9-column format with household', () => {
		const content = [
			'| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App | User | Household |',
			'|-----------|----------|-------|-------------|---------------|----------|-----|------|-----------|',
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice | hh-1 |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].user).toBe('alice');
		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-1');
		expect(result.perHousehold[0].callCount).toBe(1);
		expect(result.perHousehold[0].totalCost).toBeCloseTo(0.001, 6);
	});

	it('aggregates per-household costs across multiple rows', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice | hh-1 |',
			'| 2026-03-11T11:00:00Z | anthropic | sonnet | 200 | 100 | 0.002 | echo | bob | hh-1 |',
			'| 2026-03-11T12:00:00Z | anthropic | sonnet | 100 | 50 | 0.003 | echo | carol | hh-2 |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.perHousehold).toHaveLength(2);
		const hh1 = result.perHousehold.find((h) => h.householdId === 'hh-1');
		expect(hh1?.callCount).toBe(2);
		expect(hh1?.totalCost).toBeCloseTo(0.003, 6);
		const hh2 = result.perHousehold.find((h) => h.householdId === 'hh-2');
		expect(hh2?.callCount).toBe(1);
	});

	it('handles mixed 8-col and 9-col rows — 8-col rows excluded from perHousehold', () => {
		const content = [
			// 8-col row (no household)
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice |',
			// 9-col row with household
			'| 2026-03-11T11:00:00Z | anthropic | sonnet | 100 | 50 | 0.002 | echo | bob | hh-1 |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(2);
		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-1');
		expect(result.totalCost).toBeCloseTo(0.003, 6);
	});

	it('excludes - and __platform__ household values from perHousehold aggregation', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice | - |',
			'| 2026-03-11T11:00:00Z | anthropic | sonnet | 100 | 50 | 0.002 | echo | bob | __platform__ |',
			'| 2026-03-11T12:00:00Z | anthropic | sonnet | 100 | 50 | 0.003 | echo | carol | hh-real |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-real');
	});

	it('returns empty perHousehold when no 9-col rows exist', () => {
		const content = '| 2026-03-11T10:00:00Z | anthropic | model | 100 | 50 | 0.001 | app | user |';

		const result = parseUsageMarkdown(content);

		expect(result.perHousehold).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Unit tests: escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
	it('escapes all dangerous characters', () => {
		expect(escapeHtml('<script>alert("xss")</script>')).toBe(
			'&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
		);
	});

	it('escapes ampersands and single quotes', () => {
		expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
	});

	it('returns empty string unchanged', () => {
		expect(escapeHtml('')).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Integration tests: routes
// ---------------------------------------------------------------------------

describe('LLM Usage Routes', () => {
	let app: Awaited<ReturnType<typeof Fastify>>;
	let modelSelector: ModelSelector;

	afterEach(async () => {
		if (app) await app.close();
	});

	describe('GET /gui/llm', () => {
		it('renders tier assignments with provider info', async () => {
			const built = await buildApp();
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm');

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('anthropic');
			expect(res.body).toContain('claude-sonnet-4-20250514');
			expect(res.body).toContain('Tier Assignments');
		});

		it('shows providers table', async () => {
			const built = await buildApp({
				providerRegistry: createMockProviderRegistry([
					{ id: 'anthropic', type: 'anthropic' },
					{ id: 'google', type: 'google' },
				]),
			});
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm');

			expect(res.body).toContain('anthropic');
			expect(res.body).toContain('google');
			expect(res.body).toContain('Providers');
		});

		it('shows "Not configured" for reasoning when undefined', async () => {
			const built = await buildApp();
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm');

			expect(res.body).toContain('Not configured');
		});
	});

	describe('POST /gui/llm/tiers', () => {
		it('updates fast tier and returns HX-Refresh', async () => {
			const built = await buildApp({
				providerRegistry: createMockProviderRegistry([{ id: 'anthropic', type: 'anthropic' }]),
			});
			app = built.app;
			modelSelector = built.modelSelector;

			const res = await authenticatedPost(app, '/gui/llm/tiers', {
				tier: 'fast',
				provider: 'anthropic',
				model: 'claude-haiku-4-5-20251001',
			});

			expect(res.statusCode).toBe(204);
			expect(res.headers['hx-refresh']).toBe('true');
			expect(modelSelector.setFastRef).toHaveBeenCalledWith({
				provider: 'anthropic',
				model: 'claude-haiku-4-5-20251001',
			});
		});

		it('updates standard tier', async () => {
			const built = await buildApp({
				providerRegistry: createMockProviderRegistry([{ id: 'anthropic', type: 'anthropic' }]),
			});
			app = built.app;
			modelSelector = built.modelSelector;

			const res = await authenticatedPost(app, '/gui/llm/tiers', {
				tier: 'standard',
				provider: 'anthropic',
				model: 'claude-sonnet-4-20250514',
			});

			expect(res.statusCode).toBe(204);
			expect(modelSelector.setStandardRef).toHaveBeenCalled();
		});

		it('updates reasoning tier', async () => {
			const built = await buildApp({
				providerRegistry: createMockProviderRegistry([{ id: 'anthropic', type: 'anthropic' }]),
			});
			app = built.app;
			modelSelector = built.modelSelector;

			const res = await authenticatedPost(app, '/gui/llm/tiers', {
				tier: 'reasoning',
				provider: 'anthropic',
				model: 'claude-opus-4-6',
			});

			expect(res.statusCode).toBe(204);
			expect(modelSelector.setReasoningRef).toHaveBeenCalled();
		});

		it('rejects invalid tier with 400', async () => {
			const built = await buildApp({
				providerRegistry: createMockProviderRegistry([{ id: 'anthropic', type: 'anthropic' }]),
			});
			app = built.app;

			const res = await authenticatedPost(app, '/gui/llm/tiers', {
				tier: 'invalid',
				provider: 'anthropic',
				model: 'some-model',
			});

			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('Invalid tier');
		});

		it('rejects missing tier with 400', async () => {
			const built = await buildApp();
			app = built.app;

			const res = await authenticatedPost(app, '/gui/llm/tiers', {
				provider: 'anthropic',
				model: 'some-model',
			});

			expect(res.statusCode).toBe(400);
		});

		it('rejects invalid provider pattern with 400', async () => {
			const built = await buildApp();
			app = built.app;

			const res = await authenticatedPost(app, '/gui/llm/tiers', {
				tier: 'fast',
				provider: '<script>alert(1)</script>',
				model: 'some-model',
			});

			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('Invalid provider');
		});

		it('rejects invalid model pattern with 400', async () => {
			const built = await buildApp({
				providerRegistry: createMockProviderRegistry([{ id: 'anthropic', type: 'anthropic' }]),
			});
			app = built.app;

			const res = await authenticatedPost(app, '/gui/llm/tiers', {
				tier: 'fast',
				provider: 'anthropic',
				model: 'model with spaces!',
			});

			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('Invalid model');
		});

		it('rejects unknown provider with 400', async () => {
			const built = await buildApp({
				providerRegistry: createMockProviderRegistry([{ id: 'anthropic', type: 'anthropic' }]),
			});
			app = built.app;

			const res = await authenticatedPost(app, '/gui/llm/tiers', {
				tier: 'fast',
				provider: 'nonexistent',
				model: 'some-model',
			});

			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('Unknown provider');
		});
	});

	describe('POST /gui/llm/models (backward compat)', () => {
		it('still works for standard model update', async () => {
			const built = await buildApp();
			app = built.app;
			modelSelector = built.modelSelector;

			const res = await authenticatedPost(app, '/gui/llm/models', {
				standardModel: 'claude-opus-4-6',
			});

			expect(res.statusCode).toBe(204);
			expect(modelSelector.setStandardModel).toHaveBeenCalledWith('claude-opus-4-6');
		});

		it('rejects invalid model ID with 400', async () => {
			const built = await buildApp();
			app = built.app;

			const res = await authenticatedPost(app, '/gui/llm/models', {
				standardModel: 'invalid model!',
			});

			expect(res.statusCode).toBe(400);
		});
	});

	describe('GET /gui/llm/metrics', () => {
		it('returns live metrics HTML fragment', async () => {
			const built = await buildApp();
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm/metrics');

			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');
			// Default: 0 active households, 0 msg/min
			expect(res.body).toContain('0');
			expect(res.body).toContain('msg/min');
		});
	});

	describe('GET /gui/llm/available-models', () => {
		it('renders models grouped by provider', async () => {
			const models: CatalogModel[] = [
				{
					id: 'claude-sonnet',
					displayName: 'Claude Sonnet',
					createdAt: '',
					pricing: { input: 3.0, output: 15.0 },
					provider: 'anthropic',
					providerType: 'anthropic',
				},
				{
					id: 'gpt-4o',
					displayName: 'GPT-4o',
					createdAt: '',
					pricing: { input: 2.5, output: 10.0 },
					provider: 'openai',
					providerType: 'openai-compatible',
				},
			];

			const built = await buildApp({ modelCatalog: createMockCatalog(models) });
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm/available-models');

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('anthropic');
			expect(res.body).toContain('openai');
			expect(res.body).toContain('claude-sonnet');
			expect(res.body).toContain('gpt-4o');
		});

		it('correctly marks active model using provider+model comparison', async () => {
			// Same model ID from two different providers — only one should be "Active"
			const models: CatalogModel[] = [
				{
					id: 'claude-sonnet-4-20250514',
					displayName: 'Sonnet (Anthropic)',
					createdAt: '',
					pricing: { input: 3.0, output: 15.0 },
					provider: 'anthropic',
					providerType: 'anthropic',
				},
				{
					id: 'claude-sonnet-4-20250514',
					displayName: 'Sonnet (Custom)',
					createdAt: '',
					pricing: { input: 3.0, output: 15.0 },
					provider: 'custom-endpoint',
					providerType: 'openai-compatible',
				},
			];

			const built = await buildApp({ modelCatalog: createMockCatalog(models) });
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm/available-models');

			// Only one "Active" for standard (the anthropic one)
			const activeCount = (res.body.match(/class="status-ok">Active</g) ?? []).length;
			// Standard column: 1 active for anthropic, 0 for custom-endpoint
			// Fast column: neither matches (fast is haiku, not sonnet)
			expect(activeCount).toBe(1);
		});

		it('HTML-escapes provider names', async () => {
			const models: CatalogModel[] = [
				{
					id: 'model-1',
					displayName: 'Model One',
					createdAt: '',
					pricing: null,
					provider: '<script>xss</script>',
					providerType: 'openai-compatible',
				},
			];

			const built = await buildApp({ modelCatalog: createMockCatalog(models) });
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm/available-models');

			expect(res.body).not.toContain('<script>xss</script>');
			expect(res.body).toContain('&lt;script&gt;');
		});

		it('shows error message when catalog fails', async () => {
			const failingCatalog = {
				getModels: vi.fn().mockRejectedValue(new Error('API key invalid')),
				refresh: vi.fn(),
			} as unknown as ModelCatalog;

			const built = await buildApp({ modelCatalog: failingCatalog });
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm/available-models');

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Failed to load available models');
		});

		it('shows "Set" buttons that post to /gui/llm/tiers', async () => {
			const models: CatalogModel[] = [
				{
					id: 'some-model',
					displayName: 'Some Model',
					createdAt: '',
					pricing: { input: 1.0, output: 2.0 },
					provider: 'anthropic',
					providerType: 'anthropic',
				},
			];

			const built = await buildApp({ modelCatalog: createMockCatalog(models) });
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm/available-models');

			expect(res.body).toContain('hx-post="/gui/llm/tiers"');
		});

		it('shows pricing-table fallback models when catalog returns empty', async () => {
			const built = await buildApp({ modelCatalog: createMockCatalog([]) });
			app = built.app;

			const res = await authenticatedGet(app, '/gui/llm/available-models');

			// Even with empty catalog, pricing table models appear under "other"
			expect(res.body).toContain('other');
			expect(res.body).toContain('not in API');
		});
	});
});

// ============================================================================
// B: parseUsageMarkdown — Chunk D additions (B1–B5)
// ============================================================================

describe('parseUsageMarkdown — Chunk D edge cases', () => {
	// B1
	it('handles interleaved 9-col → 8-col → 9-col rows (not just 9-after-8)', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice | hh-1 |',
			'| 2026-03-11T11:00:00Z | anthropic | sonnet | 100 | 50 | 0.002 | echo | bob |',
			'| 2026-03-11T12:00:00Z | anthropic | sonnet | 100 | 50 | 0.003 | echo | carol | hh-2 |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(3);
		expect(result.perHousehold).toHaveLength(2);
		expect(result.perHousehold.map((h) => h.householdId).sort()).toEqual(['hh-1', 'hh-2']);
	});

	// B2
	it('handles 9-col with cells[8] containing whitespace-only value', () => {
		const content = '| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice |   |';

		const result = parseUsageMarkdown(content);

		// Whitespace-only household trims to empty → treated like '-' or empty → excluded
		expect(result.perHousehold).toHaveLength(0);
	});

	// B3
	it('handles row with pipe-split yielding more than 9 cells (trailing pipe)', () => {
		const content = '| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice | hh-1 | extra |';

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		// Should still aggregate household from cells[8]
		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-1');
	});

	// B4
	it('perHousehold sorted descending by cost', () => {
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice | hh-cheap |',
			'| 2026-03-11T11:00:00Z | anthropic | sonnet | 100 | 50 | 0.010 | echo | bob | hh-expensive |',
			'| 2026-03-11T12:00:00Z | anthropic | sonnet | 100 | 50 | 0.005 | echo | carol | hh-mid |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.perHousehold[0].householdId).toBe('hh-expensive');
		expect(result.perHousehold[1].householdId).toBe('hh-mid');
		expect(result.perHousehold[2].householdId).toBe('hh-cheap');
	});

	// B5 — high-signal regression for the blank-middle-cell column-shift bug
	it('9-col row with blank User cell still parses Household from cells[8] (blank middle cell must not shift columns left)', () => {
		// A blank User cell in an otherwise 9-col row. After pipe split + filter(Boolean),
		// the blank cell is dropped, shifting Household left into the User slot.
		// This test verifies the parser does NOT shift columns.
		const content = '| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo |  | hh-real |';

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		// Household must be attributed correctly, not silently lost
		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-real');
	});

	// B6 — both User and Household blank in a bordered 9-col row
	it('9-col row with both User and Household blank → no household, no spurious user', () => {
		const content = '| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo |  |  |';

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		expect(result.perHousehold).toHaveLength(0);
		expect(result.perUser).toHaveLength(0);
	});

	// B7 — blank App cell, populated User/Household → columns align positionally
	it('9-col row with blank App cell still places User and Household in their correct slots', () => {
		const content = '| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 |  | alice | hh-1 |';

		const result = parseUsageMarkdown(content);

		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-1');
		expect(result.perUser).toHaveLength(1);
		expect(result.perUser[0].userId).toBe('alice');
	});

	// B8 — row without a trailing bounding pipe still parses (hand-edited-log tolerance)
	it('row without a trailing bounding pipe still parses positionally', () => {
		const content = '| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice | hh-1';

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-1');
	});

	// B9 — consecutive blank interior cells do not collapse
	it('9-col row with consecutive blank interior cells does not collapse columns', () => {
		// Blank App AND blank User, household populated
		const content = '| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 |  |  | hh-consec |';

		const result = parseUsageMarkdown(content);

		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-consec');
	});

	// B11 — hardening: truly-empty interior cells (`||`) behave the same as
	// whitespace-only (`|  |`). B6/B7/B9 only exercise the whitespace form;
	// this test locks the positional-trim semantics against a refactor that
	// drops the .trim() step.
	it('9-col row with truly-empty User cell (||) parses Household from cells[8]', () => {
		// No spaces between pipes around the blank User column.
		const content = '| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo || hh-empty |';

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-empty');
		expect(result.perUser).toHaveLength(0);
	});

	// B10 — pipe-only / all-blank rows must not be pushed into `rows`.
	// Regression: Minor #1 from the review-round audit of the BUG-2 fix.
	it('pipe-only row (no timestamp) is skipped, not pushed with blank fields', () => {
		// One valid row + three degenerate forms: whitespace-only between pipes,
		// pipes only (no interior characters), and a single whitespace cell.
		// Only the valid row should survive.
		const content = [
			'| 2026-03-11T10:00:00Z | anthropic | sonnet | 100 | 50 | 0.001 | echo | alice | hh-1 |',
			'|  |  |  |  |  |  |  |  |  |',
			'|||||||||',
			'|          |',
		].join('\n');

		const result = parseUsageMarkdown(content);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].timestamp).toBe('2026-03-11T10:00:00Z');
		expect(result.perHousehold).toHaveLength(1);
		expect(result.perHousehold[0].householdId).toBe('hh-1');
	});
});

// ============================================================================
// C: buildPerHouseholdRows via GET /gui/llm (C1–C10)
// ============================================================================

describe('buildPerHouseholdRows — Chunk D (via GET /gui/llm)', () => {
	let app: Awaited<ReturnType<typeof Fastify>>;

	afterEach(async () => {
		if (app) await app.close();
	});

	// C1
	it('returns one row per household with correct cost/cap/pct', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-1', name: 'Alpha' }],
			{ 'hh-1': ['user1', 'user2'] },
		);
		const ct = { getMonthlyHouseholdCost: (_id: string) => 5.0 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: { defaultHouseholdMonthlyCostCap: 20, householdOverrides: {} } as LLMSafeguardsConfig,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Alpha');
		expect(res.body).toContain('5.000000'); // monthlyCost
		expect(res.body).toContain('25'); // pctOfCap = round(5/20 * 100) = 25
	});

	// C2
	it('household with zero calls renders row with cost=0, pct=0, overCap=false', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-zero', name: 'Zero Household' }],
			{ 'hh-zero': ['user1'] },
		);
		const ct = { getMonthlyHouseholdCost: (_id: string) => 0 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: { defaultHouseholdMonthlyCostCap: 20, householdOverrides: {} } as LLMSafeguardsConfig,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.body).toContain('Zero Household');
		expect(res.body).toContain('0.000000');
		expect(res.body).not.toContain('OVER CAP');
	});

	// C3
	it('household override cap takes precedence over default cap', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-custom', name: 'Custom Cap' }],
			{ 'hh-custom': ['user1'] },
		);
		const ct = { getMonthlyHouseholdCost: (_id: string) => 9.0 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: {
				defaultHouseholdMonthlyCostCap: 100,
				householdOverrides: { 'hh-custom': { monthlyCostCap: 10 } },
			} as LLMSafeguardsConfig,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		// pctOfCap = round(9/10 * 100) = 90, not round(9/100*100) = 9
		expect(res.body).toContain('90');
	});

	// C4
	it('cap=0 does not divide by zero (pctOfCap=0)', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-nocap', name: 'No Cap' }],
			{ 'hh-nocap': ['user1'] },
		);
		const ct = { getMonthlyHouseholdCost: (_id: string) => 5.0 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: {
				defaultHouseholdMonthlyCostCap: 0,
				householdOverrides: {},
			} as LLMSafeguardsConfig,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		// Should render without throwing; pctOfCap=0 when cap=0
		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('NaN');
	});

	// C5
	it('overCap is true only when monthlyCost > cap (NOT when pctOfCap rounds to 100)', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-boundary', name: 'Boundary' }],
			{ 'hh-boundary': ['user1'] },
		);
		// monthlyCost=0.995, cap=1.0 → pctOfCap=Math.round(99.5)=100 but cost ≤ cap
		const ct = { getMonthlyHouseholdCost: (_id: string) => 0.995 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: { defaultHouseholdMonthlyCostCap: 1.0, householdOverrides: {} } as LLMSafeguardsConfig,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		// monthlyCost(0.995) is NOT > cap(1.0) → must NOT show OVER CAP
		expect(res.body).not.toContain('OVER CAP');
	});

	// C6
	it('monthlyCost reflects live reservations via costTracker.getMonthlyHouseholdCost', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-reserve', name: 'Reserve Household' }],
			{ 'hh-reserve': ['user1'] },
		);
		// This mock simulates a costTracker that includes outstanding reservations
		const getMonthlyHouseholdCost = vi.fn().mockReturnValue(7.5);
		const ct = { getMonthlyHouseholdCost };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: { defaultHouseholdMonthlyCostCap: 20, householdOverrides: {} } as LLMSafeguardsConfig,
		});
		app = built.app;

		await authenticatedGet(app, '/gui/llm');

		// The route must have called getMonthlyHouseholdCost for the household
		expect(getMonthlyHouseholdCost).toHaveBeenCalledWith('hh-reserve');
	});

	// C7
	it('members count matches householdService.getMembers(id).length', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-members', name: 'Big Household' }],
			{ 'hh-members': ['u1', 'u2', 'u3'] }, // 3 members
		);
		const ct = { getMonthlyHouseholdCost: (_id: string) => 0 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: { defaultHouseholdMonthlyCostCap: 20, householdOverrides: {} } as LLMSafeguardsConfig,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		// The rendered table must show 3 members
		expect(res.body).toContain('>3<');
	});

	// C8
	it('no householdService provided → per-household table not rendered (empty)', async () => {
		const built = await buildApp(); // no householdServiceFull → defaults to undefined
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('Per-Household Breakdown');
	});

	// C9
	it('rows sorted by monthlyCost desc (most expensive household first)', async () => {
		const hs = makeLlmHouseholdService(
			[
				{ id: 'hh-cheap', name: 'Cheap' },
				{ id: 'hh-expensive', name: 'Expensive' },
			],
			{ 'hh-cheap': ['u1'], 'hh-expensive': ['u2'] },
		);
		const ct = {
			getMonthlyHouseholdCost: (id: string) => (id === 'hh-expensive' ? 15.0 : 2.0),
		};
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: { defaultHouseholdMonthlyCostCap: 20, householdOverrides: {} } as LLMSafeguardsConfig,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		const expensivePos = res.body.indexOf('Expensive');
		const cheapPos = res.body.indexOf('Cheap');
		expect(expensivePos).toBeGreaterThan(0);
		expect(cheapPos).toBeGreaterThan(0);
		expect(expensivePos).toBeLessThan(cheapPos); // expensive renders first
	});

	// C10
	it('listHouseholds returns empty → per-household table not rendered', async () => {
		const hs = makeLlmHouseholdService([], {});
		const ct = { getMonthlyHouseholdCost: (_id: string) => 0 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.body).not.toContain('Per-Household Breakdown');
	});

	// Hardening for BUG-1 polarity — see docs/d5c-chunk-d-review-findings.md
	it('cost exactly equal to cap → overCap=false (strict >, not >=)', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-eq', name: 'Equal' }],
			{ 'hh-eq': ['u1'] },
		);
		const ct = { getMonthlyHouseholdCost: (_id: string) => 10.0 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: { defaultHouseholdMonthlyCostCap: 10.0, householdOverrides: {} } as LLMSafeguardsConfig,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.body).not.toContain('OVER CAP');
	});

	it('cost slightly above cap → overCap=true', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-over', name: 'Slightly Over' }],
			{ 'hh-over': ['u1'] },
		);
		const ct = { getMonthlyHouseholdCost: (_id: string) => 10.01 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: { defaultHouseholdMonthlyCostCap: 10.0, householdOverrides: {} } as LLMSafeguardsConfig,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.body).toContain('OVER CAP');
	});
});

// ============================================================================
// D: Per-Household Breakdown rendering via GET /gui/llm (D1–D10)
// ============================================================================

describe('Per-Household Breakdown rendering — Chunk D', () => {
	let app: Awaited<ReturnType<typeof Fastify>>;

	afterEach(async () => {
		if (app) await app.close();
	});

	function makeSimpleHouseholdApp(
		households: Array<{ id: string; name: string; cost: number }>,
		cap = 20,
		usageContent = '',
	) {
		const hs = makeLlmHouseholdService(
			households.map(({ id, name }) => ({ id, name })),
			Object.fromEntries(households.map(({ id }) => [id, ['user1']])),
		);
		const ct = {
			getMonthlyHouseholdCost: (id: string) =>
				households.find((h) => h.id === id)?.cost ?? 0,
		};
		return buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
			llmSafeguards: { defaultHouseholdMonthlyCostCap: cap, householdOverrides: {} } as LLMSafeguardsConfig,
			usageContent,
		});
	}

	// D1
	it('renders Per-Household Breakdown table when rows present', async () => {
		const built = await makeSimpleHouseholdApp([{ id: 'hh-1', name: 'Alpha', cost: 5 }]);
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.body).toContain('Per-Household Breakdown');
		expect(res.body).toContain('Alpha');
	});

	// D2
	it('renders Per-Household Breakdown table even when usage-log file is empty', async () => {
		const built = await makeSimpleHouseholdApp([{ id: 'hh-1', name: 'Alpha', cost: 0 }], 20, '');
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		// Per-Household Breakdown renders from householdService/costTracker, independent of usage-log
		expect(res.body).toContain('Per-Household Breakdown');
		// Cost Summary section is independent — it WILL say "No usage recorded" when log is empty;
		// that is correct behavior and orthogonal to Per-Household Breakdown being present
	});

	// D3
	it('pctOfCap=45 → progress bar renders without warning or danger class (neutral state)', async () => {
		// monthlyCost=9, cap=20 → pctOfCap=round(45)=45
		const built = await makeSimpleHouseholdApp([{ id: 'hh-1', name: 'Alpha', cost: 9 }], 20);
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		// At 45%, no accent-color style should appear on progress bar
		const progressMatch = res.body.match(/<progress[^>]*>/g) ?? [];
		const hasWarning = progressMatch.some((p) => p.includes('accent-color'));
		expect(hasWarning).toBe(false);
	});

	// D4
	it('pctOfCap=85 (not over cap) → progress bar carries a warning marker distinct from neutral', async () => {
		// monthlyCost=17, cap=20 → pctOfCap=round(85)=85
		const built = await makeSimpleHouseholdApp([{ id: 'hh-1', name: 'Alpha', cost: 17 }], 20);
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		// At 85%, a warning-level accent-color must be set
		const progressMatch = res.body.match(/<progress[^>]*>/g) ?? [];
		const hasWarningMarker = progressMatch.some((p) => p.includes('accent-color'));
		expect(hasWarningMarker).toBe(true);
		// Must NOT show OVER CAP — cost(17) <= cap(20)
		expect(res.body).not.toContain('OVER CAP');
	});

	// D5
	it('pctOfCap=110 with overCap=true → progress bar carries danger marker AND OVER CAP label', async () => {
		// monthlyCost=22, cap=20 → pctOfCap=round(110)=110, overCap=monthlyCost>cap=true
		const built = await makeSimpleHouseholdApp([{ id: 'hh-1', name: 'Alpha', cost: 22 }], 20);
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.body).toContain('OVER CAP');
		// Progress bar must carry a different style than the warning state
		const progressMatch = res.body.match(/<progress[^>]*>/g) ?? [];
		const dangerMarker = progressMatch.some(
			(p) => p.includes('pico-del-color') || (p.includes('accent-color') && res.body.includes('OVER CAP')),
		);
		expect(dangerMarker).toBe(true);
	});

	// D6
	it('pctOfCap=200 → rendered HTML surfaces the raw percentage (not clamped to 100)', async () => {
		// monthlyCost=40, cap=20 → pctOfCap=200
		const built = await makeSimpleHouseholdApp([{ id: 'hh-1', name: 'Alpha', cost: 40 }], 20);
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		// The numeric percentage label must show 200 (not just 100)
		expect(res.body).toContain('200%');
	});

	// D7
	it('pctOfCap rounding boundary: cost/cap=0.995 rounds to 100 but overCap=false (no OVER CAP label)', async () => {
		// monthlyCost=0.995, cap=1.0 → pctOfCap=Math.round(99.5)=100, but cost NOT > cap
		const built = await makeSimpleHouseholdApp([{ id: 'hh-1', name: 'Alpha', cost: 0.995 }], 1);
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		// OVER CAP must NOT appear — cost is still below cap
		expect(res.body).not.toContain('OVER CAP');
	});

	// D8
	it('household name containing <script>alert(1)</script> is HTML-escaped in rendered table', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh-xss', name: '<script>alert(1)</script>' }],
			{ 'hh-xss': ['u1'] },
		);
		const ct = { getMonthlyHouseholdCost: (_id: string) => 0 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.body).not.toContain('<script>alert(1)</script>');
		expect(res.body).toContain('&lt;script&gt;');
	});

	// D9
	it('household id containing HTML entities is escaped', async () => {
		const hs = makeLlmHouseholdService(
			[{ id: 'hh&evil', name: 'Evil Household' }],
			{ 'hh&evil': ['u1'] },
		);
		const ct = { getMonthlyHouseholdCost: (_id: string) => 0 };
		const built = await buildApp({
			householdServiceFull: hs,
			monthlyCostTracker: ct,
		});
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.body).not.toContain('hh&evil');
		expect(res.body).toContain('hh&amp;evil');
	});

	// D10
	it('Live card emits hx-get="/gui/llm/metrics" with hx-trigger="every 5s" and hx-swap="innerHTML"', async () => {
		const built = await buildApp();
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm');

		expect(res.body).toContain('hx-get="/gui/llm/metrics"');
		expect(res.body).toContain('hx-trigger="every 5s"');
		expect(res.body).toContain('hx-swap="innerHTML"');
	});
});

// ============================================================================
// E: GET /gui/llm/metrics — Chunk D additions (E1–E6)
// ============================================================================

describe('GET /gui/llm/metrics — Chunk D', () => {
	let app: Awaited<ReturnType<typeof Fastify>>;

	afterEach(async () => {
		if (app) await app.close();
	});

	// E1
	it('returns live counts reflecting recordMessage calls made on the tracker', async () => {
		const tracker = new MessageRateTracker();
		tracker.recordMessage('hA');
		tracker.recordMessage('hA');
		tracker.recordMessage('hB');
		const built = await buildApp({ messageRateTracker: tracker });
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm/metrics');

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('3'); // 3 total messages
		expect(res.body).toContain('2'); // 2 active households (hA, hB)
		tracker.dispose();
	});

	// E2
	it('tracker with only platform-sentinel messages → activeHouseholds=0, msgPerMin>0', async () => {
		const tracker = new MessageRateTracker();
		tracker.recordMessage(undefined); // sentinel
		tracker.recordMessage('__platform__'); // also sentinel
		const built = await buildApp({ messageRateTracker: tracker });
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm/metrics');

		// Active households span shows 0; the number is inside a <span> tag
		expect(res.body).toContain('id="live-active-households">0</span>');
		expect(res.body).toContain('>2<'); // 2 total msg/min
		tracker.dispose();
	});

	// E3
	it('no messageRateTracker injected → renders 0/0, does not throw', async () => {
		const built = await buildApp(); // no messageRateTracker
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm/metrics');

		expect(res.statusCode).toBe(200);
		// Both active-households and rpm spans show 0
		expect(res.body).toContain('id="live-active-households">0</span>');
		expect(res.body).toContain('id="live-rpm">0</span>');
	});

	// E4
	it('non-admin user receives 403 when hitting /gui/llm/metrics', async () => {
		const built = await buildApp();
		app = built.app;

		const res = await authenticatedGetAs(app, NON_ADMIN_USER_ID, NON_ADMIN_PASSWORD, '/gui/llm/metrics');

		expect(res.statusCode).toBe(403);
	});

	// E5
	it('unauthenticated request is redirected to login (no HTML data leak)', async () => {
		const built = await buildApp();
		app = built.app;

		const res = await app.inject({ method: 'GET', url: '/gui/llm/metrics' });

		// Should redirect or 401/403 — must NOT expose metrics data to unauthenticated caller
		expect(res.statusCode).not.toBe(200);
		expect(res.body).not.toContain('msg/min');
	});

	// E6
	it('response fragment shape matches the #live-metrics htmx target (contains live-active-households and live-rpm spans)', async () => {
		const built = await buildApp();
		app = built.app;

		const res = await authenticatedGet(app, '/gui/llm/metrics');

		expect(res.body).toContain('id="live-active-households"');
		expect(res.body).toContain('id="live-rpm"');
	});
});
