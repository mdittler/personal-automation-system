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
	const inputs = over.inputs ?? [{ payload: 'p', expected: {} }];
	return {
		caseId: 'demo',
		bucket: 'routing',
		routingTarget: 'food-shadow',
		description: 'demo',
		oracle: 'structural',
		coverage: ['x.ts'],
		inputs,
		inputCount: over.inputCount ?? inputs.length,
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

	it('emits id: <n> header before each event line (REQ-REG-GUI-V2-021)', async () => {
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
			pendingRuns[0]?.emit({ type: 'case-result', result: { caseId: 'a' } });
			pendingRuns[0]?.emit({ type: 'summary', summary: {} });
			pendingRuns[0]?.emit({ type: 'complete', summary: {} });
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
			});
			// Each event frame begins with id: <n>\n; ids start at 0 monotonically.
			expect(res.body).toMatch(/id: 0\nevent: case-completed/);
			expect(res.body).toMatch(/id: 1\nevent: summary/);
			expect(res.body).toMatch(/id: 2\nevent: complete/);
			// Initial retry directive lands first.
			expect(res.body.indexOf('retry:')).toBeLessThan(res.body.indexOf('id: 0'));
		} finally {
			await app.close();
		}
	});

	it('Last-Event-ID: 1 replays only events with id > 1 (REQ-REG-GUI-V2-021)', async () => {
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
			pendingRuns[0]?.emit({ type: 'case-result', result: { caseId: 'a' } });
			pendingRuns[0]?.emit({ type: 'case-result', result: { caseId: 'b' } });
			pendingRuns[0]?.emit({ type: 'summary', summary: {} });
			pendingRuns[0]?.emit({ type: 'complete', summary: {} });
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
				headers: { 'Last-Event-ID': '1' },
			});
			// Should NOT replay id: 0 or id: 1; should replay id: 2 (summary) and id: 3 (complete).
			expect(res.body).not.toMatch(/id: 0\n/);
			expect(res.body).not.toMatch(/id: 1\n/);
			expect(res.body).toContain('id: 2\nevent: summary');
			expect(res.body).toContain('id: 3\nevent: complete');
			// Only one case-completed frame should be missing (the second one, id=1).
			const caseCompletedCount = (res.body.match(/event: case-completed/g) ?? []).length;
			expect(caseCompletedCount).toBe(0);
		} finally {
			await app.close();
		}
	});

	it('Last-Event-ID newer than all events returns empty replay (no events lost)', async () => {
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
			pendingRuns[0]?.emit({ type: 'case-result', result: { caseId: 'a' } });
			pendingRuns[0]?.emit({ type: 'complete', summary: {} });
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
				headers: { 'Last-Event-ID': '5' },
			});
			// The replay loop should be empty (no events with id > 5), and since the
			// run is already terminal, no live listener is registered. The response
			// contains the initial retry directive but no data events.
			expect(res.body).toContain('retry:');
			expect(res.body).not.toContain('event: case-completed');
			expect(res.body).not.toContain('event: complete');
		} finally {
			await app.close();
		}
	});

	it('No Last-Event-ID header falls back to full replay (initial connect path)', async () => {
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
			pendingRuns[0]?.emit({ type: 'case-result', result: { caseId: 'a' } });
			pendingRuns[0]?.emit({ type: 'complete', summary: {} });
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
			});
			expect(res.body).toContain('id: 0\nevent: case-completed');
			expect(res.body).toContain('id: 1\nevent: complete');
		} finally {
			await app.close();
		}
	});

	it('Non-numeric Last-Event-ID treated as null (full replay)', async () => {
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
			pendingRuns[0]?.emit({ type: 'case-result', result: { caseId: 'a' } });
			pendingRuns[0]?.emit({ type: 'complete', summary: {} });
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
				headers: { 'Last-Event-ID': 'not-a-number' },
			});
			// Should fall through to full replay since the header is non-numeric.
			expect(res.body).toContain('id: 0\nevent: case-completed');
		} finally {
			await app.close();
		}
	});

	it('emits synthetic "gap" event when ring buffer evicted requested id (REQ-REG-GUI-V2-022)', async () => {
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
			// Force ring-buffer overflow by emitting MAX+5 events. Earliest
			// retained id = 5; client asking for last id=2 → gap.
			const MAX = 1000; // MAX_EVENT_LOG_ENTRIES
			for (let i = 0; i < MAX + 5; i++) {
				pendingRuns[0]?.emit({ type: 'case-result', result: { caseId: `c-${i}` } });
			}
			// Sanity check: registry should report a gap for last id < 4.
			const state = runRegistry.get(runId);
			expect(state?.eventLog[0]?.id).toBe(5);
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
				headers: { 'Last-Event-ID': '2' },
			});
			expect(res.body).toContain('event: gap');
			// Gap event has no id field (it's a control message).
			const frameAfterRetry = res.body.split('\n\n').find((f) => f.includes('event: gap'));
			expect(frameAfterRetry).not.toMatch(/^id:/);
			pendingRuns[0]?.finish();
		} finally {
			await app.close();
		}
	});

	it('terminal-run replay emits all events then closes (no live attach, no duplicates)', async () => {
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
			pendingRuns[0]?.emit({ type: 'case-result', result: { caseId: 'a' } });
			pendingRuns[0]?.emit({ type: 'complete', summary: {} });
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
			});
			// Exactly one of each event type — no duplicates from a stray live attach.
			const completedCount = (res.body.match(/event: case-completed/g) ?? []).length;
			const terminalCount = (res.body.match(/event: complete\n/g) ?? []).length;
			expect(completedCount).toBe(1);
			expect(terminalCount).toBe(1);
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

	function sseFrameData(body: string, eventName: string): Record<string, unknown> {
		const frame = body.split('\n\n').find((f) => f.includes(`event: ${eventName}`));
		if (!frame) throw new Error(`no ${eventName} frame in SSE body`);
		const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
		if (!dataLine) throw new Error(`no data line in ${eventName} frame`);
		return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
	}

	it('gate-failed SSE event carries a server-formatted banner naming the model', async () => {
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
			pendingRuns[0]?.emit({
				type: 'summary',
				summary: { pass: 30, totalCases: 33, routingAccuracy: 0.906, routingInputsEvaluated: 53 },
				modelIds: { fast: 'gemma4:26b', standard: 'claude-sonnet-4-6', reasoning: null },
			});
			pendingRuns[0]?.emit({
				type: 'gate-failed',
				summary: { pass: 30, totalCases: 33, routingAccuracy: 0.906, routingInputsEvaluated: 53 },
				exitCode: 1,
				modelIds: { fast: 'gemma4:26b', standard: 'claude-sonnet-4-6', reasoning: null },
			});
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
			});
			const data = sseFrameData(res.body, 'gate-failed');
			const banner = data.banner as { stateLabel: string; headline: string; lines: string[] };
			expect(banner.stateLabel).toBe('accuracy gate not met');
			expect(banner.headline).toContain('not a crash');
			expect(banner.lines.join(' ')).toContain('gemma4:26b');
			expect(banner.lines.join(' ')).toContain('90.6%');
			// banner is additive — raw summary + modelIds still ship alongside
			// so existing/external consumers reading them directly keep working.
			expect(data.summary).toMatchObject({ routingAccuracy: 0.906, routingInputsEvaluated: 53 });
			expect(data.modelIds).toMatchObject({ fast: 'gemma4:26b' });
		} finally {
			await app.close();
		}
	});

	it('complete SSE event carries a server-formatted banner', async () => {
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
			pendingRuns[0]?.emit({
				type: 'summary',
				summary: { pass: 33, totalCases: 33, routingAccuracy: 0.99, routingInputsEvaluated: 53 },
				modelIds: { fast: 'gemma4:31b', standard: 'claude-sonnet-4-6', reasoning: null },
			});
			pendingRuns[0]?.emit({
				type: 'complete',
				summary: { pass: 33, totalCases: 33, routingAccuracy: 0.99, routingInputsEvaluated: 53 },
				modelIds: { fast: 'gemma4:31b', standard: 'claude-sonnet-4-6', reasoning: null },
			});
			pendingRuns[0]?.finish();
			await new Promise((r) => setImmediate(r));
			const res = await app.inject({
				method: 'GET',
				url: `/gui/regression/runs/${runId}/events`,
				cookies,
			});
			const data = sseFrameData(res.body, 'complete');
			const banner = data.banner as { stateLabel: string; headline: string; lines: string[] };
			expect(banner.stateLabel).toBe('complete');
			expect(banner.headline).toBe('Run complete.');
			expect(banner.lines.join(' ')).toContain('33/33 cases passed');
			expect(data.summary).toMatchObject({ pass: 33, totalCases: 33 });
			expect(data.modelIds).toMatchObject({ fast: 'gemma4:31b' });
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

// ─── REQ-REG-GUI-OV — POST /gui/regression/runs model-override fields ─────────
describe('POST /gui/regression/runs — modelMatrix + judgeModel (REQ-REG-GUI-OV)', () => {
	// Happy path
	it('forwards modelMatrix=fast=ollama/gemma4:31b as --model-matrix= arg', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: 'fast=ollama/gemma4:31b' },
			});
			expect(res.statusCode).toBe(202);
			expect(pendingRuns[0]?.args).toContain('--model-matrix=fast=ollama/gemma4:31b');
		} finally {
			await app.close();
		}
	});

	it('forwards judgeModel as --judge-model= arg', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: {
					_csrf: csrf,
					judgeModel: 'anthropic/claude-haiku-4-5-20251001',
				},
			});
			expect(res.statusCode).toBe(202);
			expect(pendingRuns[0]?.args).toContain('--judge-model=anthropic/claude-haiku-4-5-20251001');
		} finally {
			await app.close();
		}
	});

	it('forwards a full matrix (fast + standard + reasoning)', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const matrix =
				'fast=ollama/gemma4:31b,standard=anthropic/claude-sonnet-4-6,reasoning=anthropic/claude-opus-4-7';
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: matrix },
			});
			expect(res.statusCode).toBe(202);
			expect(pendingRuns[0]?.args).toContain(`--model-matrix=${matrix}`);
		} finally {
			await app.close();
		}
	});

	it('forwards both modelMatrix and judgeModel together', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: {
					_csrf: csrf,
					modelMatrix: 'fast=ollama/gemma4:31b',
					judgeModel: 'anthropic/claude-haiku-4-5-20251001',
				},
			});
			expect(res.statusCode).toBe(202);
			const args = pendingRuns[0]?.args ?? [];
			expect(args).toContain('--model-matrix=fast=ollama/gemma4:31b');
			expect(args).toContain('--judge-model=anthropic/claude-haiku-4-5-20251001');
		} finally {
			await app.close();
		}
	});

	it('appends NO model flags when neither field is provided (backwards compat)', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf },
			});
			expect(res.statusCode).toBe(202);
			const args = pendingRuns[0]?.args ?? [];
			expect(args.some((a) => a.startsWith('--model-matrix='))).toBe(false);
			expect(args.some((a) => a.startsWith('--judge-model='))).toBe(false);
		} finally {
			await app.close();
		}
	});

	// Edge: empty / whitespace
	it('omits --model-matrix arg when modelMatrix is empty string', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: '' },
			});
			expect(res.statusCode).toBe(202);
			expect((pendingRuns[0]?.args ?? []).some((a) => a.startsWith('--model-matrix='))).toBe(false);
		} finally {
			await app.close();
		}
	});

	it('omits --model-matrix arg when modelMatrix is whitespace-only', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: '   ' },
			});
			expect(res.statusCode).toBe(202);
			expect((pendingRuns[0]?.args ?? []).some((a) => a.startsWith('--model-matrix='))).toBe(false);
		} finally {
			await app.close();
		}
	});

	// Error handling
	it('rejects malformed modelMatrix with 400 and parser error in body', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: 'garbage' },
			});
			expect(res.statusCode).toBe(400);
			expect(res.json()).toMatchObject({ error: expect.stringMatching(/model/i) });
		} finally {
			await app.close();
		}
	});

	it('rejects malformed judgeModel with 400', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, judgeModel: 'no-slash' },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	// Security: non-string body types
	it('rejects modelMatrix sent as array with 400 (no crash)', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: [] },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('rejects modelMatrix sent as object with 400', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: { foo: 'bar' } },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('rejects judgeModel sent as number with 400', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, judgeModel: 42 },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('rejects judgeModel sent as array with 400 (no crash)', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, judgeModel: [] },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('rejects judgeModel sent as object with 400', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, judgeModel: { foo: 'bar' } },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('rejects judgeModel sent as boolean with 400', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, judgeModel: true },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('rejects modelMatrix exceeding MAX_MODEL_SPEC_CHARS with 400', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: 'a'.repeat(1024) },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	// Security: shell metachars rejected before spawn
	it('rejects modelMatrix with embedded shell metachars before spawn', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: 'fast=ollama/gemma;rm' },
			});
			expect(res.statusCode).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('rejects HTML payload in modelMatrix with 400 JSON envelope (XSS framing)', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: '<script>alert(1)</script>' },
			});
			expect(res.statusCode).toBe(400);
			expect(res.headers['content-type']).toMatch(/application\/json/i);
			// Body must be valid JSON (envelope intact); error message itself may
			// echo the payload, but JSON.stringify ensures it can't break out of
			// the JSON response context.
			const parsed = JSON.parse(res.body);
			expect(parsed.error).toBeTruthy();
		} finally {
			await app.close();
		}
	});

	// Precedence — verify judgeModel and modelMatrix=standard= flow through
	// as separate flags; the CLI's buildTierOverrideFromCli handles the
	// precedence at the LLM-service layer (judge wins). The GUI just forwards
	// both flags so the same precedence applies.
	it('forwards judgeModel + modelMatrix standard slot as two separate flags', async () => {
		const { app, pendingRuns } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: {
					_csrf: csrf,
					modelMatrix: 'standard=anthropic/claude-sonnet-4-6',
					judgeModel: 'anthropic/claude-haiku-4-5-20251001',
				},
			});
			expect(res.statusCode).toBe(202);
			const args = pendingRuns[0]?.args ?? [];
			expect(args).toContain('--model-matrix=standard=anthropic/claude-sonnet-4-6');
			expect(args).toContain('--judge-model=anthropic/claude-haiku-4-5-20251001');
		} finally {
			await app.close();
		}
	});

	// Auth — confirms unchanged posture under the new fields
	it('returns 403 for authenticated non-admin even with valid model override', async () => {
		const { app } = await buildApp();
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app, 'user');
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: 'fast=ollama/gemma4:31b' },
			});
			expect(res.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	});

	it('returns 302 redirect for unauthenticated POST with model override', async () => {
		const { app } = await buildApp();
		try {
			const res = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				payload: { modelMatrix: 'fast=ollama/gemma4:31b' },
			});
			expect(res.statusCode).toBe(302);
		} finally {
			await app.close();
		}
	});

	// Contract tests — every value the shared parser accepts/rejects in unit
	// tests must produce the same accept/reject decision through the POST.
	const ACCEPTED_BY_PARSER = [
		'fast=ollama/gemma4:31b',
		'anthropic/claude-sonnet-4-6',
		'fast=ollama/gemma4:31b,standard=anthropic/claude-sonnet-4-6',
		'ollama/gemma4:31b,anthropic/claude-sonnet-4-6,anthropic/claude-opus-4-7',
	];
	for (const matrix of ACCEPTED_BY_PARSER) {
		it(`contract: POST accepts matrix "${matrix}" (parser accepts → POST accepts)`, async () => {
			const { app, pendingRuns } = await buildApp();
			try {
				const { cookies, csrf } = await loginAndGetCsrf(app);
				const res = await app.inject({
					method: 'POST',
					url: '/gui/regression/runs',
					cookies,
					payload: { _csrf: csrf, modelMatrix: matrix },
				});
				expect(res.statusCode).toBe(202);
				expect(pendingRuns[0]?.args).toContain(`--model-matrix=${matrix}`);
			} finally {
				await app.close();
			}
		});
	}

	const REJECTED_BY_PARSER = [
		'garbage',
		'fast=ollama/gemma;rm',
		'tier1=foo/bar',
		'fast=ollama/../etc',
		'<script>alert(1)</script>',
		'fast=ollama/x,fast=anthropic/y',
	];
	for (const matrix of REJECTED_BY_PARSER) {
		it(`contract: POST rejects matrix "${matrix}" (parser rejects → POST 400)`, async () => {
			const { app } = await buildApp();
			try {
				const { cookies, csrf } = await loginAndGetCsrf(app);
				const res = await app.inject({
					method: 'POST',
					url: '/gui/regression/runs',
					cookies,
					payload: { _csrf: csrf, modelMatrix: matrix },
				});
				expect(res.statusCode).toBe(400);
			} finally {
				await app.close();
			}
		});
	}
});

// ─── REQ-REG-GUI-OV — operator persona scenario (Batch 8) ─────────────────────
describe('operator persona — runs two models back-to-back, both visible in history', () => {
	it('two POSTs with different modelMatrix overrides + seeded cache files → history shows both rows', async () => {
		const caseId = 'persona-case';
		const { app, pendingRuns, cacheDir } = await buildApp({
			listedCases: [makeListedCase({ caseId })],
		});
		try {
			const { cookies, csrf } = await loginAndGetCsrf(app);

			// Run 1: operator submits fast tier override for Gemma 4 e4b.
			const run1 = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: 'fast=ollama/gemma4:e4b' },
			});
			expect(run1.statusCode).toBe(202);
			expect(pendingRuns[0]?.args).toContain('--model-matrix=fast=ollama/gemma4:e4b');
			// Simulate the subprocess completing and writing a cache file. The
			// fake runFactory captures args but does not write cache; the GUI
			// would normally see the file appear after the real CLI exits.
			const cacheKey1 = 'a'.repeat(64);
			const caseDir1 = join(cacheDir, caseId);
			await mkdir(caseDir1, { recursive: true });
			await writeFile(
				join(caseDir1, `${cacheKey1}.json`),
				JSON.stringify({
					result: {
						caseId,
						cacheKey: cacheKey1,
						source: 'fresh',
						verdict: 'pass',
						inputs: [],
						actuals: [],
						oracleVerdicts: [],
						tokenCounts: { input: 0, output: 0 },
						costUsd: 0,
						modelIds: {
							fast: 'gemma4:e4b',
							standard: 'claude-sonnet-4-6',
							reasoning: null,
						},
						timestamp: '2026-05-13T00:00:00Z',
						durationMs: 1000,
					},
				}),
			);
			pendingRuns[0]?.emit({ type: 'complete', summary: { totalCases: 1 } });
			pendingRuns[0]?.finish();
			// Let the registry settle so activeRunId clears.
			await new Promise((r) => setImmediate(r));

			// Run 2: operator now switches to Gemma 4 31B.
			const run2 = await app.inject({
				method: 'POST',
				url: '/gui/regression/runs',
				cookies,
				payload: { _csrf: csrf, modelMatrix: 'fast=ollama/gemma4:31b' },
			});
			expect(run2.statusCode).toBe(202);
			expect(pendingRuns[1]?.args).toContain('--model-matrix=fast=ollama/gemma4:31b');
			// Simulate run 2 cache file.
			const cacheKey2 = 'b'.repeat(64);
			await writeFile(
				join(caseDir1, `${cacheKey2}.json`),
				JSON.stringify({
					result: {
						caseId,
						cacheKey: cacheKey2,
						source: 'fresh',
						verdict: 'pass',
						inputs: [],
						actuals: [],
						oracleVerdicts: [],
						tokenCounts: { input: 0, output: 0 },
						costUsd: 0,
						modelIds: {
							fast: 'gemma4:31b',
							standard: 'claude-sonnet-4-6',
							reasoning: null,
						},
						timestamp: '2026-05-13T00:01:00Z',
						durationMs: 1000,
					},
				}),
			);
			pendingRuns[1]?.emit({ type: 'complete', summary: { totalCases: 1 } });
			pendingRuns[1]?.finish();
			await new Promise((r) => setImmediate(r));

			// Operator visits the history view → both model runs visible.
			const history = await app.inject({
				method: 'GET',
				url: `/gui/regression/cases/${caseId}/history`,
				cookies,
			});
			expect(history.statusCode).toBe(200);
			expect(history.body).toContain('gemma4:e4b');
			expect(history.body).toContain('gemma4:31b');
		} finally {
			await app.close();
		}
	});
});
