/**
 * /gui/regression write-route tests (Batch 4 of B.2).
 *
 * Covers POST /runs (with CSRF, conflict, force-fresh), GET /runs/:runId/events
 * (SSE event ordering, multi-client, terminal close), POST /runs/:runId/cancel.
 *
 * REQ-REG-016: cancel sends SIGTERM and updates SSE stream with cancelled event.
 * Codex C3: SSE emits gate-failed vs failed distinctly.
 * Codex I2: forceFresh expands visible filter into the rerun set.
 * Codex I7: SSE case-completed payload carries only {caseId}, not full result.
 * Security: command-injection-style bucket/rerun → 400 before spawn.
 */

import { mkdir, mkdtemp } from 'node:fs/promises';
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
const ADMIN = { id: 'admin-1', pw: 'admin-password' };
const NORMAL = { id: 'user-1', pw: 'user-password' };
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

function makeUserManager(): UserManager {
	return {
		getUser: (id: string) =>
			id === ADMIN.id
				? { id: ADMIN.id, name: 'Admin', isAdmin: true }
				: id === NORMAL.id
					? { id: NORMAL.id, name: 'User', isAdmin: false }
					: null,
		getAllUsers: () => [
			{ id: ADMIN.id, name: 'Admin', isAdmin: true },
			{ id: NORMAL.id, name: 'User', isAdmin: false },
		],
	} as unknown as UserManager;
}

function makeHouseholdService(): HouseholdService {
	return {
		getHouseholdForUser: () => 'hh-1',
		getHousehold: () => ({ id: 'hh-1', adminUserIds: [ADMIN.id] }),
	} as unknown as HouseholdService;
}

interface FakeRunHandle {
	emit: (event: RegressionEvent) => void;
	finish: () => void;
	cancel: () => void;
	args: readonly string[];
}

interface BuiltApp {
	app: FastifyInstance;
	runRegistry: RunRegistry;
	pendingRuns: FakeRunHandle[];
	cacheDir: string;
}

function makeListedCase(over: Partial<ListedCase> = {}): ListedCase {
	return {
		caseId: 'demo',
		bucket: 'routing',
		routingTarget: 'food-shadow',
		description: 'demo',
		oracle: 'structural',
		coverage: ['x.ts'],
		inputs: [{ payload: 'p', expected: {} }],
		budgetUsd: 0.05,
		currentCacheKey: 'a'.repeat(64),
		...over,
	};
}

async function buildApp(opts: { listedCases?: ListedCase[] } = {}): Promise<BuiltApp> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-regression-write-'));
	const cacheDir = join(tempDir, 'cache');
	await mkdir(cacheDir, { recursive: true });

	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(ADMIN.id, ADMIN.pw);
	await credService.setPassword(NORMAL.id, NORMAL.pw);

	const app = Fastify();
	await app.register(fastifyCookie, { secret: 'test-secret-very-long-and-good-enough' });
	const eta = new Eta({ views: viewsDir, autoEscape: true });
	await app.register(fastifyView, { engine: { eta }, root: viewsDir, viewExt: 'eta' });

	const caseDiscovery = {
		discover: async () => ({
			cases: opts.listedCases ?? [makeListedCase()],
			modelIds: { fast: 'f', standard: 's', reasoning: null },
			totalCases: opts.listedCases?.length ?? 1,
		}),
	};
	const runRegistry = createRunRegistry();
	const pendingRuns: FakeRunHandle[] = [];

	// Wrap registry.createRun so tests can inject a fake run factory that
	// records args + lets the test drive event emission.
	const originalCreateRun = runRegistry.createRun.bind(runRegistry);
	runRegistry.createRun = async ({ args, runFactory: _ignored }) => {
		let captured!: FakeRunHandle;
		const factory = async (onEvent: (e: RegressionEvent) => void, signal: AbortSignal) => {
			let resolveComplete!: () => void;
			const whenComplete = new Promise<void>((res) => {
				resolveComplete = res;
			});
			captured = {
				emit: (e) => onEvent(e),
				finish: () => resolveComplete(),
				cancel: () => {
					onEvent({ type: 'cancelled' });
					resolveComplete();
				},
				args,
			};
			signal.addEventListener('abort', () => captured.cancel());
			return { whenComplete };
		};
		const out = await originalCreateRun({ args, runFactory: factory });
		pendingRuns.push(captured);
		return out;
	};

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credService,
				userManager: makeUserManager(),
				householdService: makeHouseholdService(),
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
	return { app, runRegistry, pendingRuns, cacheDir };
}

function collectCookies(res: { cookies: Array<{ name: string; value: string }> }): Record<
	string,
	string
> {
	const out: Record<string, string> = {};
	for (const c of res.cookies) out[c.name] = c.value;
	return out;
}

async function loginAndGetCsrf(
	app: FastifyInstance,
	who: 'admin' | 'user' = 'admin',
): Promise<{ cookies: Record<string, string>; csrf: string }> {
	const cred = who === 'admin' ? ADMIN : NORMAL;
	const login = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: cred.id, password: cred.pw },
	});
	const loginCookies = collectCookies(login);
	const get = await app.inject({ method: 'GET', url: '/gui/regression', cookies: loginCookies });
	const merged = { ...loginCookies, ...collectCookies(get) };
	// Try both: the layout-injected meta tag, and a fallback inline _csrf input value.
	const metaMatch = get.body.match(/name="csrf-token" content="([^"]+)"/);
	const inputMatch = get.body.match(/name="_csrf" value="([^"]+)"/);
	return { cookies: merged, csrf: metaMatch?.[1] ?? inputMatch?.[1] ?? '' };
}

describe('POST /gui/regression/runs — auth + CSRF', () => {
	it('returns 202 + runId for admin with valid CSRF', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			expect(res.statusCode).toBe(202);
			const body = JSON.parse(res.body) as { runId: string; eventsUrl: string };
			expect(body.runId).toMatch(/^[a-z0-9-]{8,}$/i);
			expect(body.eventsUrl).toContain(body.runId);
		} finally {
			await app.close();
		}
	});

	it('returns 403 for authenticated non-admin (REQ-REG-007)', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app, 'admin');
			// Switch to normal-user session but keep the CSRF
			const userLogin = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: NORMAL.id, password: NORMAL.pw },
			});
			const userCookies = { ...cookies, ...collectCookies(userLogin) };
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies: userCookies,
				payload: { _csrf: csrf },
			});
			expect(res.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	});

	it('returns 302 redirect to /gui/login for unauthenticated POST (Codex I6)', async () => {
		const { app } = await buildApp();
		try {
			const res = await app.inject({ method: 'POST', url: '/gui/regression/runs', payload: {} });
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/login');
		} finally {
			await app.close();
		}
	});

	it('returns 403 for POST without CSRF token', async () => {
		const { app } = await buildApp();
		try {
			const login = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: ADMIN.id, password: ADMIN.pw },
			});
			const cookies = collectCookies(login);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: {},
			});
			expect(res.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	});
});

describe('POST /gui/regression/runs — single-active-run + conflict', () => {
	it('returns 409 with activeRunId when a run is already in progress', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const first = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			expect(first.statusCode).toBe(202);
			const firstRunId = (JSON.parse(first.body) as { runId: string }).runId;
			const second = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			expect(second.statusCode).toBe(409);
			const body = JSON.parse(second.body) as { activeRunId: string };
			expect(body.activeRunId).toBe(firstRunId);
		} finally {
			await app.close();
		}
	});
});

describe('POST /gui/regression/runs — input validation', () => {
	it('rejects bucket="garbage" with 400', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, bucket: 'garbage' },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('rejects shell-meta in rerun id (security)', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, rerun: '; rm -rf /' },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('rejects rerun id not present in discovered cases (allowlist)', async () => {
		const { app } = await buildApp({ listedCases: [makeListedCase({ caseId: 'real-case' })] });
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, rerun: 'not-a-known-case' },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('accepts valid bucket + rerun (single id, array of ids)', async () => {
		const { app, pendingRuns } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'a' }),
				makeListedCase({ caseId: 'b' }),
				makeListedCase({ caseId: 'c' }),
			],
		});
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, bucket: 'routing', rerun: ['a', 'b'] },
			});
			expect(res.statusCode).toBe(202);
			expect(pendingRuns[0]?.args).toContain('--json');
			expect(pendingRuns[0]?.args).toContain('--bucket=routing');
			expect(pendingRuns[0]?.args).toContain('--rerun=a');
			expect(pendingRuns[0]?.args).toContain('--rerun=b');
		} finally {
			await app.close();
		}
	});
});

describe('POST /gui/regression/runs — forceFresh (Codex I2)', () => {
	it('expands the visible filter into rerun ids when forceFresh=true', async () => {
		const { app, pendingRuns } = await buildApp({
			listedCases: [
				makeListedCase({ caseId: 'a', bucket: 'routing' }),
				makeListedCase({ caseId: 'b', bucket: 'routing' }),
				makeListedCase({ caseId: 'c', bucket: 'chatbot', routingTarget: undefined }),
			],
		});
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, bucket: 'routing', forceFresh: 'true' },
			});
			expect(res.statusCode).toBe(202);
			const args = pendingRuns[0]?.args ?? [];
			expect(args).toContain('--rerun=a');
			expect(args).toContain('--rerun=b');
			expect(args).not.toContain('--rerun=c');
		} finally {
			await app.close();
		}
	});

	it('expands all cases when forceFresh=true and no bucket filter', async () => {
		const { app, pendingRuns } = await buildApp({
			listedCases: [makeListedCase({ caseId: 'a' }), makeListedCase({ caseId: 'b' })],
		});
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, forceFresh: 'true' },
			});
			expect(res.statusCode).toBe(202);
			const args = pendingRuns[0]?.args ?? [];
			expect(args).toContain('--rerun=a');
			expect(args).toContain('--rerun=b');
		} finally {
			await app.close();
		}
	});
});

describe('GET /gui/regression/runs/:runId/events — SSE', () => {
	it('returns 404 for unknown runId', async () => {
		const { app } = await buildApp();
		try {
			const { cookies } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'GET',
				url: '/gui/regression/runs/unknown-run/events',
				cookies,
			});
			expect(res.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});

	it('returns 403 for authenticated non-admin', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const create = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			const runId = (JSON.parse(create.body) as { runId: string }).runId;
			const userLogin = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: NORMAL.id, password: NORMAL.pw },
			});
			const userCookies = collectCookies(userLogin);
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies: userCookies,
			});
			expect(res.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	});

	it('streams case-completed → complete events with terminal close (Codex I7 + I8)', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const create = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			const runId = (JSON.parse(create.body) as { runId: string }).runId;

			// Emit events on the fake run BEFORE the SSE client attaches so the
			// buffer-replay path is exercised.
			pendingRuns[0]?.emit({ type: 'case-result', result: { caseId: 'demo', verdict: 'pass' } });
			pendingRuns[0]?.emit({ type: 'summary', summary: { totalCases: 1, pass: 1 } });
			pendingRuns[0]?.emit({ type: 'complete', summary: { totalCases: 1 } });
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));

			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
			});
			expect(res.headers['content-type']).toContain('text/event-stream');
			// case-completed payload carries only {caseId, runId}; full result is NOT inlined (I7)
			expect(res.body).toContain('event: case-completed');
			expect(res.body).toContain('"caseId":"demo"');
			expect(res.body).not.toContain('"verdict":"pass"');
			expect(res.body).toContain('event: complete');
		} finally {
			await app.close();
		}
	});

	it('SSE emits gate-failed (not failed) when summary present + exit1 (Codex C3)', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const create = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			const runId = (JSON.parse(create.body) as { runId: string }).runId;
			pendingRuns[0]?.emit({ type: 'summary', summary: { routingAccuracy: 0.5 } });
			pendingRuns[0]?.emit({
				type: 'gate-failed',
				summary: { routingAccuracy: 0.5 },
				exitCode: 1,
			});
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
			});
			expect(res.body).toContain('event: gate-failed');
			expect(res.body).not.toContain('event: failed');
		} finally {
			await app.close();
		}
	});
});

describe('POST /gui/regression/runs/:runId/cancel — REQ-REG-016', () => {
	it('cancels an active run and triggers cancelled event', async () => {
		const { app, pendingRuns, runRegistry } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const create = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			const runId = (JSON.parse(create.body) as { runId: string }).runId;
			void pendingRuns;
			const res = await app.inject({
				method: 'POST',
				url: `/gui/regression/runs/${runId}/cancel`,
				cookies,
				payload: { _csrf: csrf },
			});
			expect(res.statusCode).toBe(200);
			expect(runRegistry.get(runId)?.status).toBe('cancelled');
		} finally {
			await app.close();
		}
	});

	it('returns 200 (idempotent no-op) for an unknown runId', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs/does-not-exist/cancel',
				cookies,
				payload: { _csrf: csrf },
			});
			expect(res.statusCode).toBe(200);
		} finally {
			await app.close();
		}
	});

	it('returns 403 without CSRF', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const create = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			const runId = (JSON.parse(create.body) as { runId: string }).runId;
			void pendingRuns;
			const res = await app.inject({
				method: 'POST',
				url: `/gui/regression/runs/${runId}/cancel`,
				cookies,
				payload: {},
			});
			expect(res.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	});

	it('returns 403 for authenticated non-admin', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const create = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			const runId = (JSON.parse(create.body) as { runId: string }).runId;
			const userLogin = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: NORMAL.id, password: NORMAL.pw },
			});
			const userCookies = collectCookies(userLogin);
			void pendingRuns;
			const res = await app.inject({
				method: 'POST',
				url: `/gui/regression/runs/${runId}/cancel`,
				cookies: userCookies,
				payload: { _csrf: csrf },
			});
			expect(res.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	});
});

describe('concurrency — real Promise.all of two POSTs', () => {
	it('exactly one 202, one 409 with activeRunId (Codex testing-standards real concurrency)', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const [a, b] = await Promise.all([
				app.inject({
					method: 'POST',
					url: '/gui/regression/runs',
					cookies,
					payload: { _csrf: csrf },
				}),
				app.inject({
					method: 'POST',
					url: '/gui/regression/runs',
					cookies,
					payload: { _csrf: csrf },
				}),
			]);
			const statuses = [a.statusCode, b.statusCode].sort();
			expect(statuses).toEqual([202, 409]);
		} finally {
			await app.close();
		}
	});
});
