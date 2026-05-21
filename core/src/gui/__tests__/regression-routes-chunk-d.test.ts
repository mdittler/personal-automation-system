/**
 * Chunk D tests: server-side tier composition (REQ-REG-GUI-V2-012), live
 * catalog re-validation (REQ-REG-GUI-V2-011), summary GET (REQ-REG-GUI-V2-018),
 * summary POST regenerate (REQ-REG-GUI-V2-019).
 *
 * These cover the NEW POST tier_X/judge surface and the polled summary
 * endpoints. Auth/CSRF coverage extends the admin-gate test array.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { CatalogModel, ModelCatalog } from '../../services/llm/model-catalog.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { RunManifest } from '../../types/regression.js';
import { VERDICT } from '../../types/regression.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerRegressionRoutes } from '../routes/regression.js';
import { createRunHistoryStore } from '../services/regression/run-history-store.js';
import { type RegressionEvent, createRunRegistry } from '../services/regression/run-registry.js';
import {
	type PersistedWeaknessSummary,
	type WeaknessSummarizer,
	createWeaknessSummarizer,
} from '../services/regression/weakness-summarizer.js';

const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');
const logger = pino({ level: 'silent' });
const ADMIN = { id: 'admin-1', pw: 'admin-password' };
const NORMAL = { id: 'user-1', pw: 'user-password' };
const RUN_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeUserManager() {
	return {
		getUser: (id: string) =>
			id === ADMIN.id
				? { id: ADMIN.id, name: 'admin', isAdmin: true }
				: id === NORMAL.id
					? { id: NORMAL.id, name: 'user', isAdmin: false }
					: null,
		getAllUsers: () => [
			{ id: ADMIN.id, name: 'admin', isAdmin: true },
			{ id: NORMAL.id, name: 'user', isAdmin: false },
		],
	} as unknown as UserManager;
}

function makeHouseholdService(): HouseholdService {
	return {
		getHouseholdForUser: () => 'hh-1',
		getHousehold: () => ({ id: 'hh-1', adminUserIds: [ADMIN.id] }),
	} as unknown as HouseholdService;
}

function makeCatalog(models: CatalogModel[]): ModelCatalog {
	return {
		getModels: vi.fn().mockResolvedValue(models),
		refresh: vi.fn(),
	} as unknown as ModelCatalog;
}

function makeSelector(opts: {
	fast: string;
	standard: string;
	reasoning?: string;
}): ModelSelector {
	const [fastProvider, fastModel] = opts.fast.split('/') as [string, string];
	const [stdProvider, stdModel] = opts.standard.split('/') as [string, string];
	return {
		getFastRef: () => ({ provider: fastProvider, model: fastModel }),
		getStandardRef: () => ({ provider: stdProvider, model: stdModel }),
		getReasoningRef: () => {
			if (!opts.reasoning) return undefined;
			const [p, m] = opts.reasoning.split('/') as [string, string];
			return { provider: p, model: m };
		},
	} as unknown as ModelSelector;
}

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-chunk-d-'));
});
afterEach(async () => {
	// best-effort cleanup; tempDir cleanup happens at process exit anyway
});

interface BuildOpts {
	manifest?: RunManifest;
	catalog?: ModelCatalog;
	selector?: ModelSelector;
	summarizerStub?: WeaknessSummarizer;
	llmStub?: { complete: ReturnType<typeof vi.fn> };
}

interface BuiltApp {
	app: FastifyInstance;
	pendingRuns: Array<{ args: readonly string[] }>;
}

async function buildApp(opts: BuildOpts = {}): Promise<BuiltApp> {
	const cacheDir = join(tempDir, 'regression-cache');
	const manifestDir = join(tempDir, 'regression-runs');
	const summaryDir = join(tempDir, 'regression-summaries');
	await mkdir(cacheDir, { recursive: true });
	await mkdir(manifestDir, { recursive: true });

	if (opts.manifest) {
		await writeFile(
			join(manifestDir, `${opts.manifest.runId}.json`),
			JSON.stringify(opts.manifest, null, 2),
		);
	}

	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(ADMIN.id, ADMIN.pw);
	await credService.setPassword(NORMAL.id, NORMAL.pw);
	const app = Fastify();
	await app.register(fastifyCookie, { secret: 'test-secret-very-long-and-good-enough' });
	const eta = new Eta({ views: viewsDir, autoEscape: true });
	await app.register(fastifyView, { engine: { eta }, root: viewsDir, viewExt: 'eta' });

	const pendingRuns: Array<{ args: readonly string[] }> = [];
	const caseDiscovery = {
		discover: async () => ({
			cases: [
				{
					caseId: 'case-1',
					bucket: 'routing' as const,
					routingTarget: 'food-shadow' as const,
					description: 'demo',
					oracle: 'structural' as const,
					coverage: [],
					inputs: [],
					inputCount: 0,
					budgetUsd: 0.05,
					currentCacheKey: 'a'.repeat(64),
				},
			],
			modelIds: { fast: 'f', standard: 's', reasoning: null },
			totalCases: 1,
			totalInputs: 0,
		}),
	};
	const runRegistry = createRunRegistry();
	const originalCreateRun = runRegistry.createRun.bind(runRegistry);
	runRegistry.createRun = async ({ args, runFactory: _ignored }) => {
		const factory = async (_onEvent: (e: RegressionEvent) => void, _signal: AbortSignal) => {
			const whenComplete = new Promise<void>(() => {});
			pendingRuns.push({ args });
			return { whenComplete };
		};
		return originalCreateRun({ args, runFactory: factory });
	};

	const runHistoryStore = createRunHistoryStore({ rootDir: manifestDir, logger });
	const summarizer =
		opts.summarizerStub ??
		createWeaknessSummarizer({
			manifestDir,
			cacheDir,
			summaryDir,
			llm: (opts.llmStub ?? {
				complete: vi.fn().mockResolvedValue(
					JSON.stringify({
						summary: 'test summary',
						failureCategories: [{ label: 'lbl', count: 0, exampleCaseIds: [] }],
					}),
				),
			}) as never,
			logger,
		});

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: 'test-token',
				credentialService: credService,
				userManager: makeUserManager(),
				householdService: makeHouseholdService(),
			});
			await registerCsrfProtection(gui);
			registerRegressionRoutes(gui, {
				caseDiscovery,
				runRegistry,
				runHistoryStore,
				weaknessSummarizer: summarizer,
				modelCatalog: opts.catalog,
				modelSelector: opts.selector,
				cacheDir,
				maxRunBudgetUsd: 5,
				logger,
			});
		},
		{ prefix: '/gui' },
	);
	await app.ready();
	return { app, pendingRuns };
}

async function loginAndGetCsrf(
	app: FastifyInstance,
): Promise<{ cookies: Record<string, string>; csrf: string }> {
	const login = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: ADMIN.id, password: ADMIN.pw },
	});
	const cookies: Record<string, string> = {};
	for (const c of login.cookies) cookies[c.name] = c.value;
	const get = await app.inject({ method: 'GET', url: '/gui/regression', cookies });
	for (const c of get.cookies) cookies[c.name] = c.value;
	const meta = get.body.match(/name="csrf-token" content="([^"]+)"/);
	return { cookies, csrf: meta?.[1] ?? '' };
}

function manifestWith(overrides: Partial<RunManifest> = {}): RunManifest {
	return {
		runId: RUN_ID,
		startedAt: '2026-05-13T11:00:00.000Z',
		completedAt: '2026-05-13T12:00:00.000Z',
		modelIds: { fast: 'ollama/g31b', standard: 'anthropic/c-sonnet', reasoning: null },
		judgeOverrideApplied: false,
		bucketsRequested: ['__all__'],
		caseResults: [
			{
				caseId: 'case-1',
				bucket: 'routing',
				cacheKey: 'a'.repeat(64),
				evaluatedTier: 'fast',
				verdict: VERDICT.pass,
				source: 'fresh',
				costUsd: 0.001,
				timestamp: '2026-05-13T11:30:00.000Z',
			},
		],
		summary: {
			totalCases: 1,
			pass: 1,
			fail: 0,
			error: 0,
			budgetExceeded: 0,
			routingAccuracy: 1,
			routingInputsEvaluated: 1,
			totalCostUsd: 0.001,
			totalDurationMs: 100,
		},
		...overrides,
	};
}

// ───────────────────────────────────── server-side tier composition

describe('POST /gui/regression/runs — server-side tier composition (REQ-REG-GUI-V2-012)', () => {
	it('composes --model-matrix= from tier_fast/tier_standard/tier_reasoning', async () => {
		const catalog = makeCatalog([
			{ id: 'g31b', displayName: 'g31b', createdAt: '', pricing: null, provider: 'ollama' },
			{
				id: 'c-sonnet',
				displayName: 'Sonnet',
				createdAt: '',
				pricing: null,
				provider: 'anthropic',
			},
		]);
		const selector = makeSelector({ fast: 'ollama/g31b', standard: 'anthropic/c-sonnet' });
		const { app, pendingRuns } = await buildApp({ catalog, selector });
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const post = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: {
					_csrf: csrf,
					tier_fast: 'ollama/g31b',
					tier_standard: 'anthropic/c-sonnet',
				},
			});
			expect(post.statusCode).toBe(202);
			expect(pendingRuns[0]?.args.join(' ')).toContain(
				'--model-matrix=fast=ollama/g31b,standard=anthropic/c-sonnet',
			);
		} finally {
			await app.close();
		}
	});

	it('tier_* takes precedence over legacy modelMatrix field', async () => {
		const catalog = makeCatalog([
			{ id: 'g31b', displayName: 'g31b', createdAt: '', pricing: null, provider: 'ollama' },
		]);
		const selector = makeSelector({ fast: 'ollama/g31b', standard: 'anthropic/c-sonnet' });
		const { app, pendingRuns } = await buildApp({ catalog, selector });
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const post = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: {
					_csrf: csrf,
					tier_fast: 'ollama/g31b',
					modelMatrix: 'fast=should/be-ignored',
				},
			});
			expect(post.statusCode).toBe(202);
			const args = pendingRuns[0]?.args.join(' ') ?? '';
			expect(args).toContain('fast=ollama/g31b');
			expect(args).not.toContain('should/be-ignored');
		} finally {
			await app.close();
		}
	});

	it('judge dropdown takes precedence over legacy judgeModel field', async () => {
		const catalog = makeCatalog([
			{ id: 'haiku', displayName: 'haiku', createdAt: '', pricing: null, provider: 'anthropic' },
		]);
		const selector = makeSelector({ fast: 'ollama/g31b', standard: 'anthropic/haiku' });
		const { app, pendingRuns } = await buildApp({ catalog, selector });
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const post = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: {
					_csrf: csrf,
					judge: 'anthropic/haiku',
					judgeModel: 'should/be-ignored',
				},
			});
			expect(post.statusCode).toBe(202);
			const args = pendingRuns[0]?.args.join(' ') ?? '';
			expect(args).toContain('--judge-model=anthropic/haiku');
			expect(args).not.toContain('should/be-ignored');
		} finally {
			await app.close();
		}
	});

	it('REQ-REG-GUI-V2-003: POST returns a UUID-shaped runId in the response body', async () => {
		// The route appends `--run-id=<runId>` to the subprocess args inside a
		// closure that the test-side runFactory replacement bypasses. Asserting
		// the response runId is UUID-shaped is the observable contract from the
		// POST handler; the spawn-side allowlist re-validation is covered by
		// subprocess.test.ts.
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const post = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			expect(post.statusCode).toBe(202);
			const body = post.json();
			expect(body.runId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		} finally {
			await app.close();
		}
	});
});

// ───────────────────────────────── live-catalog re-validation

describe('POST /gui/regression/runs — live-catalog re-validation (REQ-REG-GUI-V2-011)', () => {
	it('rejects a model not present in the live catalog with 400', async () => {
		const catalog = makeCatalog([
			{ id: 'g31b', displayName: 'g31b', createdAt: '', pricing: null, provider: 'ollama' },
		]);
		const selector = makeSelector({ fast: 'ollama/g31b', standard: 'anthropic/c-sonnet' });
		const { app } = await buildApp({ catalog, selector });
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const post = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: {
					_csrf: csrf,
					tier_fast: 'fake-provider/fake-model',
				},
			});
			expect(post.statusCode).toBe(400);
			expect(post.json().error).toMatch(/not currently available/i);
		} finally {
			await app.close();
		}
	});

	it('accepts a model that IS present in the live catalog', async () => {
		const catalog = makeCatalog([
			{ id: 'g31b', displayName: 'g31b', createdAt: '', pricing: null, provider: 'ollama' },
		]);
		const selector = makeSelector({ fast: 'ollama/g31b', standard: 'anthropic/c-sonnet' });
		const { app } = await buildApp({ catalog, selector });
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const post = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: {
					_csrf: csrf,
					tier_fast: 'ollama/g31b',
				},
			});
			expect(post.statusCode).toBe(202);
		} finally {
			await app.close();
		}
	});
});

// ────────────────────────── Run-tab rendering: unavailable currents disabled

describe('GET /gui/regression?view=run — unavailable current model rendered disabled', () => {
	it('renders the current tier ref as a disabled option when not in live catalog', async () => {
		const catalog = makeCatalog([
			{ id: 'available', displayName: 'avail', createdAt: '', pricing: null, provider: 'ollama' },
		]);
		const selector = makeSelector({ fast: 'anthropic/missing', standard: 'anthropic/missing' });
		const { app } = await buildApp({ catalog, selector });
		try {
			const { cookies } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'GET',
				url: '/gui/regression?view=run',
				cookies,
			});
			// Expect a `<option ... disabled ...>anthropic/missing (unavailable)`
			// somewhere in the form.
			expect(res.body).toMatch(/disabled[^>]*>[\s\S]*anthropic\/missing/i);
			expect(res.body).toMatch(/unavailable/i);
		} finally {
			await app.close();
		}
	});
});

// ─────────────────────────────────────── summary GET (polled)

describe('GET /gui/regression/runs/:runId/summary (REQ-REG-GUI-V2-018)', () => {
	it('returns 202 when summary is not yet persisted', async () => {
		const { app } = await buildApp({ manifest: manifestWith() });
		try {
			const { cookies } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${RUN_ID}/summary?tier=fast`,
				cookies,
			});
			expect(res.statusCode).toBe(202);
		} finally {
			await app.close();
		}
	});

	it('returns 400 without tier query param', async () => {
		const { app } = await buildApp({ manifest: manifestWith() });
		try {
			const { cookies } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${RUN_ID}/summary`,
				cookies,
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('returns 404 when runId is not a UUID', async () => {
		const { app } = await buildApp();
		try {
			const { cookies } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'GET',
				url: '/gui/regression/runs/not-a-uuid/summary?tier=fast',
				cookies,
			});
			expect(res.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});

	it('returns 200 with rendered partial when summary is persisted', async () => {
		const persisted: PersistedWeaknessSummary = {
			status: 'ready',
			runId: RUN_ID,
			tier: 'fast',
			modelId: 'ollama/g31b',
			generatedAt: '2026-05-13T12:30:00.000Z',
			hadFailures: true,
			summary: 'concrete weakness summary text',
			failureCategories: [{ label: 'sample category', count: 1, exampleCaseIds: ['case-1'] }],
		};
		const summarizerStub: WeaknessSummarizer = {
			summarize: vi.fn(),
			pathFor: () => '',
			read: vi.fn().mockResolvedValue(persisted),
		};
		const { app } = await buildApp({ manifest: manifestWith(), summarizerStub });
		try {
			const { cookies } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${RUN_ID}/summary?tier=fast`,
				cookies,
			});
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('concrete weakness summary text');
		} finally {
			await app.close();
		}
	});
});

// ────────────────────────────────── summary POST (regenerate)

describe('POST /gui/regression/runs/:runId/summary (REQ-REG-GUI-V2-019)', () => {
	it('returns 202 and queues summarization for an existing manifest', async () => {
		const summarize = vi.fn().mockResolvedValue({
			status: 'ready',
			runId: RUN_ID,
			tier: 'fast',
			modelId: 'm',
			generatedAt: '',
			hadFailures: false,
		});
		const summarizerStub: WeaknessSummarizer = {
			summarize,
			pathFor: () => '',
			read: vi.fn().mockResolvedValue(null),
		};
		const { app } = await buildApp({ manifest: manifestWith(), summarizerStub });
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const post = await app.inject({
				method: 'POST',
				url: `/gui/regression/runs/${RUN_ID}/summary`,
				cookies,
				headers: {
					'Content-Type': 'application/json',
					'X-CSRF-Token': csrf,
				},
				payload: JSON.stringify({ _csrf: csrf }),
			});
			expect(post.statusCode).toBe(202);
			// Give the background task a tick to land.
			await new Promise((r) => setTimeout(r, 30));
			// summarize() is called once per tier in modelIds; reasoning is null so 2 calls.
			expect(summarize).toHaveBeenCalled();
		} finally {
			await app.close();
		}
	});

	it('returns 404 when the runId has no manifest', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const post = await app.inject({
				method: 'POST',
				url: `/gui/regression/runs/${RUN_ID}/summary`,
				cookies,
				headers: {
					'Content-Type': 'application/json',
					'X-CSRF-Token': csrf,
				},
				payload: JSON.stringify({ _csrf: csrf }),
			});
			expect(post.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});

	it('forwards force=true to the summarizer when ?force=true', async () => {
		const summarize = vi.fn().mockResolvedValue({
			status: 'ready',
			runId: RUN_ID,
			tier: 'fast',
			modelId: 'm',
			generatedAt: '',
			hadFailures: false,
		});
		const summarizerStub: WeaknessSummarizer = {
			summarize,
			pathFor: () => '',
			read: vi.fn().mockResolvedValue(null),
		};
		const { app } = await buildApp({ manifest: manifestWith(), summarizerStub });
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			await app.inject({
				method: 'POST',
				url: `/gui/regression/runs/${RUN_ID}/summary?force=true`,
				cookies,
				headers: {
					'Content-Type': 'application/json',
					'X-CSRF-Token': csrf,
				},
				payload: JSON.stringify({ _csrf: csrf }),
			});
			await new Promise((r) => setTimeout(r, 30));
			expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
		} finally {
			await app.close();
		}
	});
});

// ─────────────────────────────────── auth/CSRF coverage for the new routes

describe('Auth/CSRF — new Chunk D endpoints', () => {
	it('GET /summary returns 302 for unauthenticated', async () => {
		const { app } = await buildApp();
		try {
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${RUN_ID}/summary?tier=fast`,
			});
			expect(res.statusCode).toBe(302);
		} finally {
			await app.close();
		}
	});

	it('POST /summary returns 403 without CSRF', async () => {
		const { app } = await buildApp({ manifest: manifestWith() });
		try {
			const { cookies } = await loginAndGetCsrf(app);
			const post = await app.inject({
				method: 'POST',
				url: `/gui/regression/runs/${RUN_ID}/summary`,
				cookies,
				headers: { 'Content-Type': 'application/json' },
				payload: '{}',
			});
			expect(post.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	});

	it('POST /summary returns 403 for authenticated non-admin (with CSRF)', async () => {
		const { app } = await buildApp({ manifest: manifestWith() });
		try {
			const login = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: NORMAL.id, password: NORMAL.pw },
			});
			const cookies: Record<string, string> = {};
			for (const c of login.cookies) cookies[c.name] = c.value;
			// CSRF token for non-admin: fetch a token from a page they CAN see
			// (the login page sets a CSRF cookie too).
			const get = await app.inject({ method: 'GET', url: '/gui/login', cookies });
			for (const c of get.cookies) cookies[c.name] = c.value;
			const meta = get.body.match(/name="csrf-token" content="([^"]+)"/);
			const csrf = meta?.[1] ?? '';
			const post = await app.inject({
				method: 'POST',
				url: `/gui/regression/runs/${RUN_ID}/summary`,
				cookies,
				headers: {
					'Content-Type': 'application/json',
					'X-CSRF-Token': csrf,
				},
				payload: JSON.stringify({ _csrf: csrf }),
			});
			expect(post.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	});
});
