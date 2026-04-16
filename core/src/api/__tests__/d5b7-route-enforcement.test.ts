/**
 * D5b-7: API route enforcement tests.
 *
 * Covers the 17 tests specified in the plan:
 * - Data route resource-kind authorization (tests 1-8)
 * - Reports/alerts delivery-list filtering and admin gates (tests 9-12)
 * - Schedules admin gate (tests 13-14)
 * - Changes fail-open prevention (tests 15-16)
 * - LLM scope enforcement (test 17)
 */

import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiAuthHook } from '../auth.js';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { ApiKeyService } from '../../services/api-keys/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { ReportService } from '../../services/reports/index.js';
import type { AlertService } from '../../services/alerts/index.js';
import type { CronManager } from '../../services/scheduler/cron-manager.js';
import type { ChangeLog } from '../../services/data-store/change-log.js';
import type { LLMService } from '../../types/llm.js';
import type { SpaceService } from '../../services/spaces/index.js';
import { registerDataRoute } from '../routes/data.js';
import { registerDataReadRoute } from '../routes/data-read.js';
import { registerReportsApiRoute } from '../routes/reports-api.js';
import { registerAlertsApiRoute } from '../routes/alerts-api.js';
import { registerSchedulesRoute } from '../routes/schedules.js';
import { registerChangesRoute } from '../routes/changes.js';
import { registerLlmRoute } from '../routes/llm.js';

const logger = pino({ level: 'silent' });
const LEGACY_TOKEN = 'legacy-api-token-for-d5b7-tests';

const ACTOR_USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const HOUSEHOLD_ID = 'hh-1';
const OTHER_HOUSEHOLD_ID = 'hh-2';
const SPACE_ID = 'space-abc';

function makeRateLimiter(): RateLimiter {
	return new RateLimiter({ windowMs: 60_000, max: 10_000 });
}

function makeUserManager(
	users: Array<{ id: string; name: string; isAdmin?: boolean }>,
): UserManager {
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users,
		isRegistered: (id: string) => users.some((u) => u.id === id),
	} as unknown as UserManager;
}

function makeHouseholdService(userToHousehold: Record<string, string>): HouseholdService {
	return {
		getHouseholdForUser: (userId: string) => userToHousehold[userId] ?? null,
		getHousehold: (_id: string) => null,
	} as unknown as HouseholdService;
}

function makeSpaceService(memberMap: Record<string, string[]>): SpaceService {
	return {
		isMember: (spaceId: string, userId: string) =>
			memberMap[spaceId]?.includes(userId) ?? false,
		getSpace: (_id: string) => null,
	} as unknown as SpaceService;
}

// ─── Helper: build a minimal Fastify server ───────────────────────────────

interface ServerOpts {
	apiKeyService: ApiKeyService;
	userManager: UserManager;
	householdService: HouseholdService;
	spaceService?: SpaceService;
	dataDir?: string;
	changeLog?: ChangeLog;
	reportService?: ReportService;
	alertService?: AlertService;
	cronManager?: CronManager;
	llm?: LLMService;
	/** When true, the auth hook is NOT added (for testing fail-open prevention). */
	skipAuthHook?: boolean;
}

async function buildServer(opts: ServerOpts) {
	const server = Fastify({ logger: false });

	if (!opts.skipAuthHook) {
		const authHook = createApiAuthHook({
			apiToken: LEGACY_TOKEN,
			rateLimiter: makeRateLimiter(),
			apiKeyService: opts.apiKeyService,
			userManager: opts.userManager,
			householdService: opts.householdService,
		});
		server.addHook('onRequest', authHook);
	}

	await server.register(
		async (api) => {
			if (opts.dataDir && opts.changeLog) {
				registerDataRoute(api, {
					dataDir: opts.dataDir,
					changeLog: opts.changeLog,
					spaceService: opts.spaceService ?? makeSpaceService({}),
					userManager: opts.userManager,
					logger,
					householdService: opts.householdService,
				});
				registerDataReadRoute(api, {
					dataDir: opts.dataDir,
					spaceService: opts.spaceService ?? makeSpaceService({}),
					userManager: opts.userManager,
					logger,
					householdService: opts.householdService,
				});
			}
			if (opts.reportService) {
				registerReportsApiRoute(api, {
					reportService: opts.reportService,
					telegram: { send: vi.fn().mockResolvedValue(undefined) } as never,
					userManager: opts.userManager,
					logger,
				});
			}
			if (opts.alertService) {
				registerAlertsApiRoute(api, {
					alertService: opts.alertService,
					logger,
				});
			}
			if (opts.cronManager) {
				registerSchedulesRoute(api, {
					cronManager: opts.cronManager,
					timezone: 'UTC',
					logger,
				});
			}
			if (opts.changeLog) {
				registerChangesRoute(api, {
					changeLog: opts.changeLog,
					logger,
				});
			}
			if (opts.llm) {
				registerLlmRoute(api, {
					llm: opts.llm,
					logger,
				});
			}
		},
		{ prefix: '/api' },
	);

	await server.ready();
	return server;
}

function makeFakeChangeLog(dataDir: string): ChangeLog {
	return {
		getLogPath: () => join(dataDir, 'system', 'change-log.jsonl'),
		record: vi.fn().mockResolvedValue(undefined),
	} as unknown as ChangeLog;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('D5b-7: API route enforcement', () => {
	let tempDir: string;
	let apiKeyService: ApiKeyService;

	const users = [
		{ id: ACTOR_USER_ID, name: 'User One', isAdmin: false },
		{ id: OTHER_USER_ID, name: 'User Two', isAdmin: false },
	];
	const userToHousehold: Record<string, string> = {
		[ACTOR_USER_ID]: HOUSEHOLD_ID,
		[OTHER_USER_ID]: HOUSEHOLD_ID, // same household as actor
	};
	const um = makeUserManager(users);
	const hs = makeHouseholdService(userToHousehold);

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-d5b7-'));
		apiKeyService = new ApiKeyService({ dataDir: tempDir, logger });
		// Create data directory structure for data-write/read tests
		await mkdir(join(tempDir, 'households', HOUSEHOLD_ID, 'users', ACTOR_USER_ID, 'notes'), {
			recursive: true,
		});
		await mkdir(join(tempDir, 'households', HOUSEHOLD_ID, 'shared', 'notes'), {
			recursive: true,
		});
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(async () => {
			await new Promise((r) => setTimeout(r, 300));
			await rm(tempDir, { recursive: true, force: true });
		});
	});

	// ─── Data route tests (1-8) ──────────────────────────────────────────────

	it('test 1: per-user key POST /api/data with own userId → 200', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['data:write'],
		});
		const changeLog = makeFakeChangeLog(tempDir);
		const server = await buildServer({ apiKeyService, userManager: um, householdService: hs, dataDir: tempDir, changeLog });

		const res = await server.inject({
			method: 'POST',
			url: '/api/data',
			headers: { authorization: `Bearer ${fullToken}` },
			payload: {
				userId: ACTOR_USER_ID,
				appId: 'notes',
				path: 'test.md',
				content: 'hello',
			},
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).ok).toBe(true);
		await server.close();
	});

	it('test 2: per-user key POST /api/data with another userId in same household → 403 (contract #16)', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['data:write'],
		});
		const changeLog = makeFakeChangeLog(tempDir);
		const server = await buildServer({ apiKeyService, userManager: um, householdService: hs, dataDir: tempDir, changeLog });

		const res = await server.inject({
			method: 'POST',
			url: '/api/data',
			headers: { authorization: `Bearer ${fullToken}` },
			payload: {
				userId: OTHER_USER_ID,
				appId: 'notes',
				path: 'test.md',
				content: 'hello',
			},
		});

		expect(res.statusCode).toBe(403);
		await server.close();
	});

	it('test 3: per-user key GET /api/data own userId → 200 (user-private path)', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['data:read'],
		});
		const changeLog = makeFakeChangeLog(tempDir);
		const server = await buildServer({ apiKeyService, userManager: um, householdService: hs, dataDir: tempDir, changeLog });

		const res = await server.inject({
			method: 'GET',
			url: `/api/data?userId=${ACTOR_USER_ID}&appId=notes&path=.`,
			headers: { authorization: `Bearer ${fullToken}` },
		});

		// Path exists as directory → should return 200 with directory listing
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		await server.close();
	});

	it('test 4: per-user key GET /api/data with another userId in same household → 403 (contract #16 read)', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['data:read'],
		});
		const changeLog = makeFakeChangeLog(tempDir);
		const server = await buildServer({ apiKeyService, userManager: um, householdService: hs, dataDir: tempDir, changeLog });

		const res = await server.inject({
			method: 'GET',
			url: `/api/data?userId=${OTHER_USER_ID}&appId=notes&path=.`,
			headers: { authorization: `Bearer ${fullToken}` },
		});

		expect(res.statusCode).toBe(403);
		await server.close();
	});

	it('test 5: per-user key GET /api/data with joined space → 200 (contract #17)', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['data:read'],
		});
		const changeLog = makeFakeChangeLog(tempDir);
		// spaceService where actor IS a member
		const spaceService = makeSpaceService({ [SPACE_ID]: [ACTOR_USER_ID] });
		const server = await buildServer({
			apiKeyService,
			userManager: um,
			householdService: hs,
			spaceService,
			dataDir: tempDir,
			changeLog,
		});

		const res = await server.inject({
			method: 'GET',
			url: `/api/data?userId=${ACTOR_USER_ID}&appId=notes&path=.&spaceId=${SPACE_ID}`,
			headers: { authorization: `Bearer ${fullToken}` },
		});

		// Space not actually on filesystem → will be not_found but not 403
		expect([200]).toContain(res.statusCode);
		await server.close();
	});

	it('test 6: per-user key GET /api/data with non-joined space → 403', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['data:read'],
		});
		const changeLog = makeFakeChangeLog(tempDir);
		// spaceService where actor is NOT a member
		const spaceService = makeSpaceService({ [SPACE_ID]: [OTHER_USER_ID] });
		const server = await buildServer({
			apiKeyService,
			userManager: um,
			householdService: hs,
			spaceService,
			dataDir: tempDir,
			changeLog,
		});

		const res = await server.inject({
			method: 'GET',
			url: `/api/data?userId=${ACTOR_USER_ID}&appId=notes&path=.&spaceId=${SPACE_ID}`,
			headers: { authorization: `Bearer ${fullToken}` },
		});

		expect(res.statusCode).toBe(403);
		await server.close();
	});

	it('test 7: key missing data:write scope → 403 on POST, key with data:read → 200 on GET', async () => {
		const { fullToken: readToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['data:read'], // no data:write
		});
		const changeLog = makeFakeChangeLog(tempDir);
		const server = await buildServer({ apiKeyService, userManager: um, householdService: hs, dataDir: tempDir, changeLog });

		// POST with read-only key → 403
		const writeRes = await server.inject({
			method: 'POST',
			url: '/api/data',
			headers: { authorization: `Bearer ${readToken}` },
			payload: {
				userId: ACTOR_USER_ID,
				appId: 'notes',
				path: 'test.md',
				content: 'hello',
			},
		});
		expect(writeRes.statusCode).toBe(403);

		// GET with read-only key → 200 (correct scope)
		const readRes = await server.inject({
			method: 'GET',
			url: `/api/data?userId=${ACTOR_USER_ID}&appId=notes&path=.`,
			headers: { authorization: `Bearer ${readToken}` },
		});
		expect(readRes.statusCode).toBe(200);

		await server.close();
	});

	it('test 8: legacy API_TOKEN → 200 on any data path (platform-system bypass)', async () => {
		const changeLog = makeFakeChangeLog(tempDir);
		const server = await buildServer({ apiKeyService, userManager: um, householdService: hs, dataDir: tempDir, changeLog });

		// POST with legacy token for OTHER user (different userId from what's in scope)
		const writeRes = await server.inject({
			method: 'POST',
			url: '/api/data',
			headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
			payload: {
				userId: OTHER_USER_ID,
				appId: 'notes',
				path: 'test.md',
				content: 'hello',
			},
		});
		expect(writeRes.statusCode).toBe(200);

		await server.close();
	});

	// ─── Reports tests (9-12) ─────────────────────────────────────────────────

	function makeReportService(reports: Array<{ id: string; delivery: string[] }>): ReportService {
		return {
			listReports: vi.fn().mockResolvedValue(
				reports.map((r) => ({ ...r, name: r.id, sections: [], schedule: '0 9 * * *' })),
			),
			getReport: vi.fn().mockImplementation(async (id: string) => {
				const r = reports.find((rep) => rep.id === id);
				return r ? { ...r, name: r.id, sections: [], schedule: '0 9 * * *', delivery: r.delivery } : null;
			}),
			run: vi.fn().mockResolvedValue({ content: 'ok', reportId: 'r1' }),
			deliver: vi.fn().mockResolvedValue(undefined),
		} as unknown as ReportService;
	}

	it('test 9: non-admin key GET /api/reports → list filtered by delivery-list membership', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['reports:read'],
		});
		const reportService = makeReportService([
			{ id: 'r1', delivery: [ACTOR_USER_ID] }, // visible to actor
			{ id: 'r2', delivery: [OTHER_USER_ID] }, // not visible to actor
			{ id: 'r3', delivery: [] }, // not visible to actor
		]);
		const server = await buildServer({
			apiKeyService, userManager: um, householdService: hs,
			reportService,
		});

		const res = await server.inject({
			method: 'GET',
			url: '/api/reports',
			headers: { authorization: `Bearer ${fullToken}` },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		expect(body.reports).toHaveLength(1);
		expect(body.reports[0].id).toBe('r1');
		await server.close();
	});

	it('test 10: non-admin key GET /api/reports/:id not in delivery list → 403', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['reports:read'],
		});
		const reportService = makeReportService([
			{ id: 'r1', delivery: [OTHER_USER_ID] }, // actor NOT in delivery
		]);
		const server = await buildServer({
			apiKeyService, userManager: um, householdService: hs,
			reportService,
		});

		const res = await server.inject({
			method: 'GET',
			url: '/api/reports/r1',
			headers: { authorization: `Bearer ${fullToken}` },
		});

		expect(res.statusCode).toBe(403);
		await server.close();
	});

	it('test 11: non-admin key POST /api/reports/:id/run → 403 even if visible', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['reports:run'],
		});
		const reportService = makeReportService([
			{ id: 'r1', delivery: [ACTOR_USER_ID] }, // actor IS in delivery
		]);
		const server = await buildServer({
			apiKeyService, userManager: um, householdService: hs,
			reportService,
		});

		const res = await server.inject({
			method: 'POST',
			url: '/api/reports/r1/run',
			headers: { authorization: `Bearer ${fullToken}` },
			payload: {},
		});

		// Non-admin actor → 403 (admin gate)
		expect(res.statusCode).toBe(403);
		await server.close();
	});

	it('test 12: legacy API_TOKEN POST /api/reports/:id/run → 200', async () => {
		const reportService = makeReportService([
			{ id: 'r1', delivery: [ACTOR_USER_ID] },
		]);
		const server = await buildServer({
			apiKeyService, userManager: um, householdService: hs,
			reportService,
		});

		const res = await server.inject({
			method: 'POST',
			url: '/api/reports/r1/run',
			headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
			payload: {},
		});

		expect(res.statusCode).toBe(200);
		await server.close();
	});

	// ─── Schedules tests (13-14) ──────────────────────────────────────────────

	function makeCronManager(): CronManager {
		return {
			getJobDetails: vi.fn().mockReturnValue([]),
		} as unknown as CronManager;
	}

	it('test 13: non-admin key GET /api/schedules → 403', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['schedules:read'],
		});
		const server = await buildServer({
			apiKeyService, userManager: um, householdService: hs,
			cronManager: makeCronManager(),
		});

		const res = await server.inject({
			method: 'GET',
			url: '/api/schedules',
			headers: { authorization: `Bearer ${fullToken}` },
		});

		expect(res.statusCode).toBe(403);
		await server.close();
	});

	it('test 14: legacy API_TOKEN GET /api/schedules → 200', async () => {
		const server = await buildServer({
			apiKeyService, userManager: um, householdService: hs,
			cronManager: makeCronManager(),
		});

		const res = await server.inject({
			method: 'GET',
			url: '/api/schedules',
			headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
		});

		expect(res.statusCode).toBe(200);
		await server.close();
	});

	// ─── Changes tests (15-16) ────────────────────────────────────────────────

	it('test 15: GET /api/changes with no actor (no auth hook) → 401 (contract #14)', async () => {
		const changeLog = makeFakeChangeLog(tempDir);
		// Server WITHOUT auth hook — so request.actor is never set
		const server = await buildServer({
			apiKeyService, userManager: um, householdService: hs,
			changeLog,
			skipAuthHook: true,
		});

		const res = await server.inject({
			method: 'GET',
			url: '/api/changes',
		});

		expect(res.statusCode).toBe(401);
		await server.close();
	});

	it('test 16: GET /api/changes with valid key → 200, household filter from ALS context', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['data:read'],
		});
		const changeLog = makeFakeChangeLog(tempDir);
		const server = await buildServer({
			apiKeyService, userManager: um, householdService: hs,
			changeLog,
		});

		const res = await server.inject({
			method: 'GET',
			url: '/api/changes',
			headers: { authorization: `Bearer ${fullToken}` },
		});

		// The route reads from the change-log file; it doesn't exist in temp dir
		// so collectChanges returns 0 entries. What matters is we got past the auth gate.
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		await server.close();
	});

	// ─── LLM test (17) ────────────────────────────────────────────────────────

	it('test 17: per-user key POST /api/llm/complete → 200 with llm:complete scope', async () => {
		const { fullToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['llm:complete'],
		});

		const mockLlm: LLMService = {
			complete: vi.fn().mockResolvedValue('Test response'),
		} as unknown as LLMService;

		const server = await buildServer({
			apiKeyService, userManager: um, householdService: hs,
			llm: mockLlm,
		});

		const res = await server.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: { authorization: `Bearer ${fullToken}` },
			payload: { prompt: 'Hello world' },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		expect(body.text).toBe('Test response');

		// Also verify a key without the scope → 403
		const { fullToken: noScopeToken } = await apiKeyService.createKey(ACTOR_USER_ID, {
			scopes: ['data:read'], // no llm:complete
		});
		const forbiddenRes = await server.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: { authorization: `Bearer ${noScopeToken}` },
			payload: { prompt: 'Hello world' },
		});
		expect(forbiddenRes.statusCode).toBe(403);

		await server.close();
	});
});
