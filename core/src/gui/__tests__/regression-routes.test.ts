/**
 * /gui/regression read-only route tests (Batch 3 of B.2).
 *
 * REQ-REG-007: admin-only — all 5 read routes return 403 for non-admin
 *              authenticated users; 302 redirect to /gui/login for
 *              unauthenticated requests (Codex I6 — matches auth.ts:296).
 *
 * REQ-REG-013: per-case model IDs, token counts (em-dash), cost, timestamp.
 *
 * Codex C2: cache-reader returns current-key entry, NOT newer stale.
 * Codex C5: never-run drilldown renders inputs + expected from ListedCase.
 * Codex I7: case-row partial returns server-rendered escaped HTML; SSE
 *           clients fetch this rather than building HTML from payload.
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
import { describe, expect, it } from 'vitest';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { RunResult } from '../../types/regression.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerRegressionRoutes } from '../routes/regression.js';
import type { ListedCase } from '../services/regression/case-discovery.js';
import {
	type RegressionEvent,
	type RunRegistry,
	createRunRegistry,
} from '../services/regression/run-registry.js';

const AUTH_TOKEN = 'test-token';
const ADMIN_USER_ID = 'admin-1';
const ADMIN_PASSWORD = 'admin-password';
const NORMAL_USER_ID = 'user-1';
const NORMAL_PASSWORD = 'user-password';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

function makeUserManager(users: Array<{ id: string; name: string; isAdmin: boolean }>) {
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users,
	} as unknown as UserManager;
}

function makeHouseholdService(): HouseholdService {
	return {
		getHouseholdForUser: () => 'hh-1',
		getHousehold: () => ({ id: 'hh-1', adminUserIds: [ADMIN_USER_ID] }),
	} as unknown as HouseholdService;
}

const HEX64 = (c: string): string => c.repeat(64);

function makeListedCase(overrides: Partial<ListedCase> = {}): ListedCase {
	return {
		caseId: 'demo-case',
		bucket: 'routing',
		routingTarget: 'food-shadow',
		description: 'a demo case',
		oracle: 'structural',
		coverage: ['x.ts'],
		inputs: [{ label: 'i1', payload: 'hi', expected: { intent: 'x' } }],
		budgetUsd: 0.05,
		currentCacheKey: HEX64('a'),
		...overrides,
	};
}

function makeRunResult(
	overrides: Partial<RunResult> & { caseId: string; cacheKey: string },
): RunResult {
	return {
		caseId: overrides.caseId,
		cacheKey: overrides.cacheKey,
		source: 'fresh',
		verdict: 'pass',
		inputs: [{ payload: 'hi', expected: { intent: 'x' } }],
		actuals: [{ intent: 'x' }],
		oracleVerdicts: [{ verdict: 'pass', details: 'matches' }],
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0.0042,
		modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
		timestamp: '2026-05-10T00:00:00Z',
		durationMs: 123,
		...overrides,
	};
}

interface BuildOptions {
	listedCases?: ListedCase[];
	discoveryError?: string;
	cachedResults?: Array<{ caseId: string; cacheKey: string; result: RunResult }>;
	registry?: RunRegistry;
}

interface BuiltApp {
	app: FastifyInstance;
	cacheDir: string;
	runRegistry: RunRegistry;
	tempDir: string;
}

async function buildApp(opts: BuildOptions = {}): Promise<BuiltApp> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-regression-routes-'));
	const cacheDir = join(tempDir, 'regression-cache');
	await mkdir(cacheDir, { recursive: true });

	// Seed cache files
	for (const c of opts.cachedResults ?? []) {
		const dir = join(cacheDir, c.caseId);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${c.cacheKey}.json`), JSON.stringify({ result: c.result }, null, 2));
	}

	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(ADMIN_USER_ID, ADMIN_PASSWORD);
	await credService.setPassword(NORMAL_USER_ID, NORMAL_PASSWORD);
	const userManager = makeUserManager([
		{ id: ADMIN_USER_ID, name: 'Admin', isAdmin: true },
		{ id: NORMAL_USER_ID, name: 'NormalUser', isAdmin: false },
	]);
	const householdService = makeHouseholdService();

	const app = Fastify();
	await app.register(fastifyCookie, { secret: 'test-secret-very-long-and-good-enough' });
	const eta = new Eta({ views: viewsDir, autoEscape: true });
	await app.register(fastifyView, { engine: { eta }, root: viewsDir, viewExt: 'eta' });

	const caseDiscovery = {
		discover: async () => ({
			cases: opts.listedCases ?? [],
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			totalCases: opts.listedCases?.length ?? 0,
			...(opts.discoveryError ? { error: opts.discoveryError } : {}),
		}),
	};
	const runRegistry = opts.registry ?? createRunRegistry();

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credService,
				userManager,
				householdService,
			});
			await registerCsrfProtection(gui);
			registerRegressionRoutes(gui, {
				caseDiscovery,
				runRegistry,
				cacheDir,
				maxRunBudgetUsd: 5,
				logger,
			});
		},
		{ prefix: '/gui' },
	);
	await app.ready();
	return { app, cacheDir, runRegistry, tempDir };
}

function collectCookies(res: { cookies: Array<{ name: string; value: string }> }): Record<
	string,
	string
> {
	const out: Record<string, string> = {};
	for (const c of res.cookies) out[c.name] = c.value;
	return out;
}

async function loginAs(
	app: FastifyInstance,
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

async function getAuthed(
	app: FastifyInstance,
	url: string,
	userId = ADMIN_USER_ID,
	password = ADMIN_PASSWORD,
): Promise<{ statusCode: number; body: string }> {
	const cookies = await loginAs(app, userId, password);
	const res = await app.inject({ method: 'GET', url, cookies });
	return { statusCode: res.statusCode, body: res.body };
}

describe('REQ-REG-007 — admin gate on all read routes', () => {
	const READ_ROUTES = [
		'/gui/regression',
		'/gui/regression/cases/demo-case',
		'/gui/regression/cases/demo-case/row',
		'/gui/regression/cases/demo-case/history',
		'/gui/regression/estimate',
	];

	for (const route of READ_ROUTES) {
		it(`${route} returns 200 for admin`, async () => {
			const { app } = await buildApp({
				listedCases: [makeListedCase()],
			});
			try {
				const res = await getAuthed(app, route);
				expect(res.statusCode).toBe(200);
			} finally {
				await app.close();
			}
		});

		it(`${route} returns 403 for authenticated non-admin`, async () => {
			const { app } = await buildApp({
				listedCases: [makeListedCase()],
			});
			try {
				const res = await getAuthed(app, route, NORMAL_USER_ID, NORMAL_PASSWORD);
				expect(res.statusCode).toBe(403);
			} finally {
				await app.close();
			}
		});

		it(`${route} returns 302 redirect to /gui/login for unauthenticated request (Codex I6)`, async () => {
			const { app } = await buildApp({ listedCases: [makeListedCase()] });
			try {
				const res = await app.inject({ method: 'GET', url: route });
				expect(res.statusCode).toBe(302);
				expect(res.headers.location).toBe('/gui/login');
			} finally {
				await app.close();
			}
		});
	}
});

describe('GET /gui/regression — page rendering (REQ-REG-013)', () => {
	it('renders the case list with tier model badges + status icons', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'has-cache', currentCacheKey: HEX64('a') })],
			cachedResults: [
				{
					caseId: 'has-cache',
					cacheKey: HEX64('a'),
					result: makeRunResult({ caseId: 'has-cache', cacheKey: HEX64('a') }),
				},
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('fast-m');
			expect(res.body).toContain('std-m');
			expect(res.body).toContain('has-cache');
			expect(res.body).toContain('✓'); // pass icon
			expect(res.body).toContain('$0.0042'); // cost
			expect(res.body).toContain('2026-05-10T00:00:00Z');
		} finally {
			await app.close();
		}
	});

	it('renders "never run" (●) for a case with no cache', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'never-run-case' })],
		});
		try {
			const res = await getAuthed(app, '/gui/regression');
			expect(res.body).toContain('never-run-case');
			expect(res.body).toContain('●');
		} finally {
			await app.close();
		}
	});

	it('renders "coverage changed" (⚠) when cached cacheKey differs from currentCacheKey', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'changed', currentCacheKey: HEX64('b') })],
			cachedResults: [
				{
					caseId: 'changed',
					cacheKey: HEX64('a'),
					result: makeRunResult({ caseId: 'changed', cacheKey: HEX64('a') }),
				},
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression');
			expect(res.body).toContain('⚠');
			expect(res.body).toContain('coverage changed');
		} finally {
			await app.close();
		}
	});

	it('renders discovery error banner + disables Run controls when --list fails closed (Codex I4)', async () => {
		const { app } = await buildApp({
			discoveryError: 'regression --list exited 1: boom',
		});
		try {
			const res = await getAuthed(app, '/gui/regression');
			expect(res.body).toContain('Failed to enumerate cases');
			expect(res.body).toContain('boom');
		} finally {
			await app.close();
		}
	});

	it('filters by bucket via ?bucket= query param', async () => {
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'r-1', bucket: 'routing' }),
				makeListedCase({
					caseId: 'p-1',
					bucket: 'receipt',
					routingTarget: undefined,
				}),
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression?bucket=routing');
			expect(res.body).toContain('r-1');
			expect(res.body).not.toContain('p-1');
		} finally {
			await app.close();
		}
	});

	it('renders an empty-state when bucket filter matches nothing', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'r-1', bucket: 'routing' })],
		});
		try {
			const res = await getAuthed(app, '/gui/regression?bucket=chatbot');
			expect(res.body).toContain('No cases in this bucket');
		} finally {
			await app.close();
		}
	});

	it('renders the per-bucket cost estimate in the Run button label (REQ-REG-017)', async () => {
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'a', bucket: 'routing' }),
				makeListedCase({ caseId: 'b', bucket: 'routing' }),
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression');
			expect(res.body).toMatch(/est\.\s*≈\s*\$0\.\d/);
		} finally {
			await app.close();
		}
	});

	it('renders the token-counts footnote (REQ-REG-013 token gap is documented)', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression');
			expect(res.body).toMatch(/token counts.*not yet plumbed/i);
		} finally {
			await app.close();
		}
	});
});

describe('GET /gui/regression/cases/:caseId — drilldown (Codex C5)', () => {
	it('renders inputs + expected from ListedCase even when never run', async () => {
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({
					caseId: 'never-run-drill',
					inputs: [{ label: 'i1', payload: 'hi', expected: { intent: 'save-recipe' } }],
				}),
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression/cases/never-run-drill');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('i1');
			expect(res.body).toContain('save-recipe');
			expect(res.body).toContain('Never run');
		} finally {
			await app.close();
		}
	});

	it('renders full result + oracle verdicts when cache hit', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'has-drill', currentCacheKey: HEX64('a') })],
			cachedResults: [
				{
					caseId: 'has-drill',
					cacheKey: HEX64('a'),
					result: makeRunResult({
						caseId: 'has-drill',
						cacheKey: HEX64('a'),
						oracleVerdicts: [{ verdict: 'pass', details: 'shape ok' }],
					}),
				},
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression/cases/has-drill');
			expect(res.body).toContain('shape ok');
			expect(res.body).toContain('fast-m');
		} finally {
			await app.close();
		}
	});

	it('returns 404 for unknown caseId (allowlist defense)', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression/cases/unknown-case-id');
			expect(res.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});

	it('returns 404 for traversal-shaped caseId (defense in depth)', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression/cases/..%2Fpasswd');
			expect(res.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});
});

describe('GET /gui/regression/cases/:caseId/row — server-rendered row (Codex I7)', () => {
	it('renders a single row with escaped HTML', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'row-test' })],
			cachedResults: [
				{
					caseId: 'row-test',
					cacheKey: HEX64('a'),
					result: makeRunResult({ caseId: 'row-test', cacheKey: HEX64('a') }),
				},
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression/cases/row-test/row');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('row-test');
			expect(res.body).toContain('✓');
		} finally {
			await app.close();
		}
	});

	it('escapes hostile content in cached actuals (XSS via SSE→row flow)', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'xss-row' })],
			cachedResults: [
				{
					caseId: 'xss-row',
					cacheKey: HEX64('a'),
					result: makeRunResult({
						caseId: 'xss-row',
						cacheKey: HEX64('a'),
						actuals: ['<script>window.__x=1</script>'],
					}),
				},
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression/cases/xss-row');
			expect(res.body).not.toContain('<script>window.__x');
			expect(res.body).toContain('&lt;script&gt;');
		} finally {
			await app.close();
		}
	});

	it('reflects the live run result when ?runId= matches the in-progress run (Codex I7)', async () => {
		const registry = createRunRegistry();
		// Manually buffer a fake run with a case-result event:
		const liveResult = makeRunResult({
			caseId: 'live-case',
			cacheKey: HEX64('z'),
			verdict: 'fail',
		});
		let runId: string;
		let activeOnEvent!: (e: RegressionEvent) => void;
		runId = (
			await registry.createRun({
				args: ['--json'],
				runFactory: (onEvent) => {
					activeOnEvent = onEvent;
					return undefined;
				},
			})
		).runId;
		activeOnEvent({ type: 'case-result', result: liveResult });
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'live-case', currentCacheKey: HEX64('z') })],
			registry,
		});
		try {
			const res = await getAuthed(app, `/gui/regression/cases/live-case/row?runId=${runId}`);
			expect(res.body).toContain('✗'); // fail icon
		} finally {
			await app.close();
		}
	});
});

describe('GET /gui/regression/cases/:caseId/history', () => {
	it('renders all cache entries DESC by timestamp', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'hist' })],
			cachedResults: [
				{
					caseId: 'hist',
					cacheKey: HEX64('a'),
					result: makeRunResult({
						caseId: 'hist',
						cacheKey: HEX64('a'),
						timestamp: '2026-05-01T00:00:00Z',
					}),
				},
				{
					caseId: 'hist',
					cacheKey: HEX64('b'),
					result: makeRunResult({
						caseId: 'hist',
						cacheKey: HEX64('b'),
						timestamp: '2026-05-10T00:00:00Z',
					}),
				},
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression/cases/hist/history');
			expect(res.statusCode).toBe(200);
			expect(res.body.indexOf('2026-05-10')).toBeLessThan(res.body.indexOf('2026-05-01'));
		} finally {
			await app.close();
		}
	});

	it('renders empty-state when no history', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase({ caseId: 'empty' })] });
		try {
			const res = await getAuthed(app, '/gui/regression/cases/empty/history');
			expect(res.body).toContain('No runs recorded');
		} finally {
			await app.close();
		}
	});
});

describe('GET /gui/regression/estimate', () => {
	it('returns JSON totals matching the per-bucket constants (REQ-REG-017)', async () => {
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'r1', bucket: 'routing' }),
				makeListedCase({ caseId: 'r2', bucket: 'routing' }),
			],
		});
		try {
			const cookies = await loginAs(app, ADMIN_USER_ID, ADMIN_PASSWORD);
			const res = await app.inject({ method: 'GET', url: '/gui/regression/estimate', cookies });
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body) as {
				totalUsd: number;
				ceilingUsd: number;
				totalCases: number;
				perBucketUsd: Record<string, number>;
			};
			expect(body.totalCases).toBe(2);
			expect(body.perBucketUsd.routing).toBeGreaterThan(0);
			expect(body.perBucketUsd.receipt).toBe(0);
			expect(body.ceilingUsd).toBe(5);
		} finally {
			await app.close();
		}
	});

	it('honours bucket query param', async () => {
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'r1', bucket: 'routing' }),
				makeListedCase({ caseId: 'p1', bucket: 'receipt', routingTarget: undefined }),
			],
		});
		try {
			const cookies = await loginAs(app, ADMIN_USER_ID, ADMIN_PASSWORD);
			const res = await app.inject({
				method: 'GET',
				url: '/gui/regression/estimate?bucket=receipt',
				cookies,
			});
			const body = JSON.parse(res.body) as { totalCases: number };
			expect(body.totalCases).toBe(1);
		} finally {
			await app.close();
		}
	});

	it('honours rerun query param (expands to specified cases only)', async () => {
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'a' }),
				makeListedCase({ caseId: 'b' }),
				makeListedCase({ caseId: 'c' }),
			],
		});
		try {
			const cookies = await loginAs(app, ADMIN_USER_ID, ADMIN_PASSWORD);
			const res = await app.inject({
				method: 'GET',
				url: '/gui/regression/estimate?rerun=a&rerun=c',
				cookies,
			});
			const body = JSON.parse(res.body) as { totalCases: number };
			expect(body.totalCases).toBe(2);
		} finally {
			await app.close();
		}
	});
});
