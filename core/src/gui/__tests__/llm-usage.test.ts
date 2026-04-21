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
import type { LLMServiceImpl } from '../../services/llm/index.js';
import type { CatalogModel, ModelCatalog } from '../../services/llm/model-catalog.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { ProviderRegistry } from '../../services/llm/providers/provider-registry.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { escapeHtml, parseUsageMarkdown, registerLlmUsageRoutes } from '../routes/llm-usage.js';

const AUTH_TOKEN = 'test-token';
const TEST_USER_ID = '123';
const TEST_PASSWORD = 'test-password';
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
	const userManager = makeUserManager([{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true }]);
	const householdService = makeHouseholdService(
		{ [TEST_USER_ID]: 'hh-1' },
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
			});
		},
		{ prefix: '/gui' },
	);

	return { app, modelSelector, providerRegistry, modelCatalog, tempDir };
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
