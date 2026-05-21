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

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
import type { ManifestCaseResult, RunManifest, RunResult } from '../../types/regression.js';
import { VERDICT } from '../../types/regression.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerRegressionRoutes } from '../routes/regression.js';
import type { ListedCase } from '../services/regression/case-discovery.js';
import type { RunHistoryStore } from '../services/regression/run-history-store.js';
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
	const inputs = overrides.inputs ?? [{ label: 'i1', payload: 'hi', expected: { intent: 'x' } }];
	return {
		caseId: 'demo-case',
		bucket: 'routing',
		routingTarget: 'food-shadow',
		description: 'a demo case',
		oracle: 'structural',
		coverage: ['x.ts'],
		inputs,
		inputCount: overrides.inputCount ?? inputs.length,
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
		verdict: VERDICT.pass,
		inputs: [{ payload: 'hi', expected: { intent: 'x' } }],
		actuals: [{ intent: 'x' }],
		oracleVerdicts: [{ verdict: VERDICT.pass, details: 'matches' }],
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
	runHistoryStore?: RunHistoryStore;
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
				...(opts.runHistoryStore ? { runHistoryStore: opts.runHistoryStore } : {}),
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
			const res = await getAuthed(app, '/gui/regression?view=compare');
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
			const res = await getAuthed(app, '/gui/regression?view=compare');
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
			const res = await getAuthed(app, '/gui/regression?view=compare');
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
			const res = await getAuthed(app, '/gui/regression?view=compare');
			expect(res.body).toContain('Failed to enumerate cases');
			expect(res.body).toContain('boom');
		} finally {
			await app.close();
		}
	});

	it('filters by bucket via ?view=compare&bucket=… query params', async () => {
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
			const res = await getAuthed(app, '/gui/regression?view=compare&bucket=routing');
			expect(res.body).toContain('r-1');
			expect(res.body).not.toContain('p-1');
		} finally {
			await app.close();
		}
	});

	it('REQ-REG-GUI-V2-005: legacy ?bucket= redirects 302 to Compare tab', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'r-1', bucket: 'routing' })],
		});
		try {
			const cookies = await loginAs(app, ADMIN_USER_ID, ADMIN_PASSWORD);
			const res = await app.inject({
				method: 'GET',
				url: '/gui/regression?bucket=routing',
				cookies,
			});
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/regression?view=compare&bucket=routing');
		} finally {
			await app.close();
		}
	});

	it('renders an empty-state when bucket filter matches nothing', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'r-1', bucket: 'routing' })],
		});
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare&bucket=chatbot');
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
			const res = await getAuthed(app, '/gui/regression?view=compare');
			expect(res.body).toMatch(/est\.\s*≈\s*\$0\.\d/);
		} finally {
			await app.close();
		}
	});

	it('renders the token-counts footnote (REQ-REG-013 token gap is documented)', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare');
			expect(res.body).toMatch(/token counts.*not yet plumbed/i);
		} finally {
			await app.close();
		}
	});

	it('REQ-REG-GUI-V2-007: default view is Overview when ?view is absent', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression');
			expect(res.statusCode).toBe(200);
			// Overview shell renders the tab strip + the overview partial. No
			// runHistoryStore was injected, so the empty-state placeholder shows.
			expect(res.body).toMatch(/No runs recorded yet/i);
			expect(res.body).toMatch(/aria-current="page"[^>]*>Overview|>Overview<\/a>/);
		} finally {
			await app.close();
		}
	});

	it('REQ-REG-GUI-V2-007: ?view=trends renders the trends partial', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=trends');
			expect(res.statusCode).toBe(200);
			// Trends partial has a `?window=` selector and an empty-state when
			// no run history exists.
			expect(res.body).toMatch(/data-testid="trends-window"/);
			expect(res.body).toMatch(/No runs in this window|trends-empty/i);
		} finally {
			await app.close();
		}
	});

	it('REQ-REG-GUI-V2-007: ?view=run renders the Run launcher form', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=run');
			expect(res.statusCode).toBe(200);
			expect(res.body).toMatch(/name="tier_fast"/);
			expect(res.body).toMatch(/name="tier_standard"/);
			expect(res.body).toMatch(/name="tier_reasoning"/);
			expect(res.body).toMatch(/name="judge"/);
		} finally {
			await app.close();
		}
	});

	it('REQ-REG-GUI-V2-017: Compare filter chips render with model/verdict/caseId inputs', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare');
			expect(res.body).toMatch(/data-testid="compare-filter-model"/);
			expect(res.body).toMatch(/data-testid="compare-filter-verdict"/);
			expect(res.body).toMatch(/data-testid="compare-filter-case-id"/);
		} finally {
			await app.close();
		}
	});

	it('REQ-REG-GUI-V2-017: ?caseId=<x> filters the Compare case table to a single case', async () => {
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'wanted-case', bucket: 'routing' }),
				makeListedCase({ caseId: 'other-case', bucket: 'routing' }),
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare&caseId=wanted-case');
			expect(res.body).toContain('wanted-case');
			expect(res.body).not.toContain('other-case');
		} finally {
			await app.close();
		}
	});

	it('REQ-REG-GUI-V2-020: drilldown renders the "see across all runs" link', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase({ caseId: 'd-1' })] });
		try {
			const res = await getAuthed(app, '/gui/regression/cases/d-1');
			expect(res.body).toMatch(
				/href="\/gui\/regression\?view=compare&caseId=d-1"|data-testid="drilldown-cross-model-link"/,
			);
		} finally {
			await app.close();
		}
	});
});

// ─── REQ-REG-GUI-OV-008 — UI inputs for model-override surface ────────────────
describe('GET /gui/regression — model-override form inputs (REQ-REG-GUI-OV-008)', () => {
	it('renders an input named "modelMatrix" inside the run form', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare');
			expect(res.body).toMatch(/<input[^>]+name="modelMatrix"/);
		} finally {
			await app.close();
		}
	});

	it('renders an input named "judgeModel" inside the run form', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare');
			expect(res.body).toMatch(/<input[^>]+name="judgeModel"/);
		} finally {
			await app.close();
		}
	});

	it('renders accessible aria-label for each model-override input', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare');
			// One of: <label>Model matrix override<input ...></label>
			//       or <input ... aria-label="Model matrix override">
			expect(res.body).toMatch(/aria-label="Model matrix override"|>\s*Model matrix override\s*</i);
			expect(res.body).toMatch(/aria-label="Judge model override"|>\s*Judge model override\s*</i);
		} finally {
			await app.close();
		}
	});

	it('each model-override input has a placeholder showing provider/model syntax', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare');
			expect(res.body).toMatch(/name="modelMatrix"[^>]*placeholder="[^"]+\//);
			expect(res.body).toMatch(/name="judgeModel"[^>]*placeholder="[^"]+\//);
		} finally {
			await app.close();
		}
	});

	it('neither model-override input is required (preserves empty-form submit)', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare');
			// Match the modelMatrix input element and assert "required" is not in it.
			const matrixInput = res.body.match(/<input[^>]+name="modelMatrix"[^>]*>/)?.[0] ?? '';
			expect(matrixInput).not.toMatch(/\brequired\b/);
			const judgeInput = res.body.match(/<input[^>]+name="judgeModel"[^>]*>/)?.[0] ?? '';
			expect(judgeInput).not.toMatch(/\brequired\b/);
		} finally {
			await app.close();
		}
	});

	it('CSRF hidden input is still present alongside the new fields', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression?view=compare');
			expect(res.body).toMatch(/<input[^>]+type="hidden"[^>]+name="_csrf"/);
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
						oracleVerdicts: [{ verdict: VERDICT.pass, details: 'shape ok' }],
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
			verdict: VERDICT.fail,
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

	it('returns 404 for a regex-valid but unknown caseId (Codex P2 allowlist)', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase({ caseId: 'real-case' })] });
		try {
			const res = await getAuthed(app, '/gui/regression/cases/not-discovered/history');
			expect(res.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});

	// REQ-REG-GUI-OV-007 — distinct modelIds → distinct cache rows visible in history
	it('renders two history rows for the same case under different fast-tier models', async () => {
		const { app } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'modeled' })],
			cachedResults: [
				{
					caseId: 'modeled',
					cacheKey: HEX64('a'),
					result: makeRunResult({
						caseId: 'modeled',
						cacheKey: HEX64('a'),
						modelIds: { fast: 'gemma4:e4b', standard: 'claude-sonnet-4-6', reasoning: null },
						timestamp: '2026-05-13T00:00:00Z',
					}),
				},
				{
					caseId: 'modeled',
					cacheKey: HEX64('b'),
					result: makeRunResult({
						caseId: 'modeled',
						cacheKey: HEX64('b'),
						modelIds: { fast: 'gemma4:31b', standard: 'claude-sonnet-4-6', reasoning: null },
						timestamp: '2026-05-13T00:01:00Z',
					}),
				},
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression/cases/modeled/history');
			expect(res.statusCode).toBe(200);
			// Both fast-tier model IDs should be present in the rendered HTML.
			expect(res.body).toContain('gemma4:e4b');
			expect(res.body).toContain('gemma4:31b');
		} finally {
			await app.close();
		}
	});
});

describe('GET /gui/regression — client wiring (Codex P1)', () => {
	it('renders the regression-live script block so the page is end-to-end wired', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression');
			expect(res.statusCode).toBe(200);
			// The page must include the EventSource bootstrap script.
			expect(res.body).toContain('new EventSource(');
			// And the cancel + estimate confirm + per-row fetch handlers.
			expect(res.body).toContain('cancel-btn');
			expect(res.body).toContain('/gui/regression/estimate?');
			expect(res.body).toContain("'case-completed'");
			// Terminal handlers read the server-formatted banner off `e.data`.
			expect(res.body).toContain('.banner');
			expect(res.body).toContain('payload.headline');
		} finally {
			await app.close();
		}
	});

	it('client wrapper includes reconnect + gap + 3-strike banner wiring (REQ-REG-GUI-V2-021/024)', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase()] });
		try {
			const res = await getAuthed(app, '/gui/regression');
			expect(res.statusCode).toBe(200);
			// Open handler resets failure counter on successful reconnect.
			expect(res.body).toMatch(/addEventListener\(['"]open['"]/);
			// Gap event triggers a full page reload.
			expect(res.body).toMatch(/addEventListener\(['"]gap['"]/);
			expect(res.body).toContain('window.location.reload');
			// Error handler increments failureCount and shows the "Lost connection" banner.
			expect(res.body).toMatch(/addEventListener\(['"]error['"]/);
			expect(res.body).toContain('failureCount');
			expect(res.body).toContain('Lost connection');
			// Terminal-state guard prevents reconnect after run end.
			expect(res.body).toContain('terminalReached');
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

	it('returns totalInputs (REQ-REG-GUI-V2-023) — all-bucket query', async () => {
		// Two cases with 4 + 3 inputs = 7 total. Mirrors FOOD_PERSONAS fan-out
		// where the per-case input count is higher than 1.
		const inputs4 = [1, 2, 3, 4].map((i) => ({ payload: `p${i}`, expected: {} }));
		const inputs3 = [1, 2, 3].map((i) => ({ payload: `p${i}`, expected: {} }));
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'r1', bucket: 'routing', inputs: inputs4 }),
				makeListedCase({ caseId: 'r2', bucket: 'routing', inputs: inputs3 }),
			],
		});
		try {
			const cookies = await loginAs(app, ADMIN_USER_ID, ADMIN_PASSWORD);
			const res = await app.inject({ method: 'GET', url: '/gui/regression/estimate', cookies });
			const body = JSON.parse(res.body) as { totalCases: number; totalInputs: number };
			expect(body.totalCases).toBe(2);
			expect(body.totalInputs).toBe(7);
		} finally {
			await app.close();
		}
	});

	it('returns totalInputs (REQ-REG-GUI-V2-023) — bucket-filtered query', async () => {
		const inputs5 = [1, 2, 3, 4, 5].map((i) => ({ payload: `p${i}`, expected: {} }));
		const inputs2 = [1, 2].map((i) => ({ payload: `p${i}`, expected: {} }));
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'r1', bucket: 'routing', inputs: inputs5 }),
				makeListedCase({
					caseId: 'p1',
					bucket: 'receipt',
					routingTarget: undefined,
					inputs: inputs2,
				}),
			],
		});
		try {
			const cookies = await loginAs(app, ADMIN_USER_ID, ADMIN_PASSWORD);
			const res = await app.inject({
				method: 'GET',
				url: '/gui/regression/estimate?bucket=receipt',
				cookies,
			});
			const body = JSON.parse(res.body) as { totalCases: number; totalInputs: number };
			expect(body.totalCases).toBe(1);
			expect(body.totalInputs).toBe(2);
		} finally {
			await app.close();
		}
	});

	it('Run tab renders "N cases / M inputs" summary (REQ-REG-GUI-V2-023)', async () => {
		const inputs4 = [1, 2, 3, 4].map((i) => ({ payload: `p${i}`, expected: {} }));
		const inputs3 = [1, 2, 3].map((i) => ({ payload: `p${i}`, expected: {} }));
		const { app } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'r1', bucket: 'routing', inputs: inputs4 }),
				makeListedCase({ caseId: 'r2', bucket: 'routing', inputs: inputs3 }),
			],
		});
		try {
			const res = await getAuthed(app, '/gui/regression?view=run');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('data-testid="case-input-count"');
			expect(res.body).toMatch(/2 cases \/ 7 inputs/);
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

// ──────────────── Overview leaderboard — per-input routing accuracy display
//
// The gate badge must derive from the per-input routing accuracy (the metric
// REQ-REG-011 actually gates on), and the figure must render next to it so
// "30/33 pass" (per-case) and "FAIL" (per-input) can never look contradictory
// without explanation. CSS guard: `gate-failed` is amber, not red.

function manifestCase(over: Partial<ManifestCaseResult> & { caseId: string }): ManifestCaseResult {
	return {
		bucket: 'routing',
		cacheKey: HEX64('a'),
		evaluatedTier: 'fast',
		verdict: VERDICT.pass,
		source: 'fresh',
		costUsd: 0.001,
		timestamp: '2026-05-13T11:00:00.000Z',
		...over,
	};
}

function overviewManifest(opts: {
	runId: string;
	fast?: string;
	standard?: string;
	caseResults: ManifestCaseResult[];
	routingAccuracy: number | null;
	routingInputsEvaluated: number;
}): RunManifest {
	const pass = opts.caseResults.filter((c) => c.verdict === VERDICT.pass).length;
	const fail = opts.caseResults.filter((c) => c.verdict === VERDICT.fail).length;
	const error = opts.caseResults.filter((c) => c.verdict === VERDICT.error).length;
	return {
		runId: opts.runId,
		startedAt: '2026-05-13T10:00:00.000Z',
		completedAt: '2026-05-13T11:00:00.000Z',
		modelIds: {
			fast: opts.fast ?? 'gemma4:26b',
			standard: opts.standard ?? 'claude-sonnet-4-6',
			reasoning: null,
		},
		judgeOverrideApplied: false,
		bucketsRequested: ['__all__'],
		caseResults: opts.caseResults,
		summary: {
			totalCases: opts.caseResults.length,
			pass,
			fail,
			error,
			budgetExceeded: 0,
			routingAccuracy: opts.routingAccuracy,
			routingInputsEvaluated: opts.routingInputsEvaluated,
			totalCostUsd: 0.003,
			totalDurationMs: 1000,
		},
	};
}

function fakeHistoryStore(manifests: RunManifest[]): RunHistoryStore {
	return {
		list: async () => manifests,
		getById: async (id) => manifests.find((m) => m.runId === id) ?? null,
		latestPerTierAndModel: async () => new Map(),
	};
}

describe('Overview leaderboard — per-input routing accuracy', () => {
	it('fast row above the gate renders PASS with the per-input accuracy figure', async () => {
		const manifest = overviewManifest({
			runId: 'run-pass',
			fast: 'gemma4:31b',
			caseResults: [manifestCase({ caseId: 'c1' }), manifestCase({ caseId: 'c2' })],
			routingAccuracy: 0.9811,
			routingInputsEvaluated: 53,
		});
		const { app } = await buildApp({ runHistoryStore: fakeHistoryStore([manifest]) });
		try {
			const res = await getAuthed(app, '/gui/regression?view=overview');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('badge-ok');
			expect(res.body).toContain('98.1% / 53 inputs');
		} finally {
			await app.close();
		}
	});

	it('shows FAIL + per-input accuracy even when per-case counts look healthy', async () => {
		// Contradiction case: every case passed (per-case 3/3) but the per-input
		// routing accuracy is below the 0.95 gate. The badge must say FAIL and the
		// 90.6% figure must sit next to it so the two numbers are reconcilable.
		const manifest = overviewManifest({
			runId: 'run-contradiction',
			fast: 'gemma4:26b',
			caseResults: [
				manifestCase({ caseId: 'c1', verdict: VERDICT.pass }),
				manifestCase({ caseId: 'c2', verdict: VERDICT.pass }),
				manifestCase({ caseId: 'c3', verdict: VERDICT.pass }),
			],
			routingAccuracy: 0.906,
			routingInputsEvaluated: 53,
		});
		const { app } = await buildApp({ runHistoryStore: fakeHistoryStore([manifest]) });
		try {
			const res = await getAuthed(app, '/gui/regression?view=overview');
			expect(res.body).toContain('badge-err');
			expect(res.body).toContain('90.6% / 53 inputs');
			// per-case count is still shown in the Cases column — both lenses visible
			expect(res.body).toContain('3/3 pass');
		} finally {
			await app.close();
		}
	});

	it('does not leak run-wide routing accuracy onto a standard-tier row', async () => {
		// Standard-tier-only run; summary carries a routingAccuracy but routing
		// cases evaluate on the fast tier — the standard row must show "—" and
		// no "% / inputs" figure.
		const manifest = overviewManifest({
			runId: 'run-standard',
			caseResults: [manifestCase({ caseId: 's1', bucket: 'chatbot', evaluatedTier: 'standard' })],
			routingAccuracy: 0.906,
			routingInputsEvaluated: 53,
		});
		const { app } = await buildApp({ runHistoryStore: fakeHistoryStore([manifest]) });
		try {
			const res = await getAuthed(app, '/gui/regression?view=overview');
			expect(res.body).not.toContain('90.6% / 53 inputs');
			expect(res.body).toContain('gate not applicable');
		} finally {
			await app.close();
		}
	});

	it('renders no accuracy figure when routingAccuracy is null (below floor)', async () => {
		const manifest = overviewManifest({
			runId: 'run-null',
			caseResults: [manifestCase({ caseId: 'c1' })],
			routingAccuracy: null,
			routingInputsEvaluated: 0,
		});
		const { app } = await buildApp({ runHistoryStore: fakeHistoryStore([manifest]) });
		try {
			const res = await getAuthed(app, '/gui/regression?view=overview');
			expect(res.body).not.toMatch(/\d+\.\d% \/ \d+ inputs/);
			expect(res.body).toContain('gate not applicable');
		} finally {
			await app.close();
		}
	});
});

describe('pas.css — terminal banner state styling', () => {
	it('gate-failed uses the warning token and failed uses the danger token', async () => {
		const css = await readFile(join(moduleDir, 'public', 'pas.css'), 'utf8');
		const gateFailed = css.slice(css.indexOf('.terminal-gate-failed'));
		expect(gateFailed).toMatch(/\.terminal-gate-failed\s*{[^}]*--pas-warning/);
		const failed = css.slice(css.indexOf('.terminal-failed'));
		expect(failed).toMatch(/\.terminal-failed\s*{[^}]*--pas-danger/);
		// gate-failed must NOT borrow the danger token — it is not a crash.
		expect(/\.terminal-gate-failed\s*{[^}]*--pas-danger/.test(css)).toBe(false);
	});
});
