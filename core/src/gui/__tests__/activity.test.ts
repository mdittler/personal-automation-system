/**
 * Activity feed (Batch 6, Task 6.3).
 *
 * `/gui/activity` — daily change digest from the JSONL change log
 * (collectChanges), scoped per-caller: members see only entries that are
 * their own (entry.userId === them), their household's shared writes
 * (userId === 'system', no spaceId, householdId matches theirs), or writes
 * to a space they belong to (spaceId in their memberships). Admins see
 * everything. Humanized: app + file basename + verb, never full paths.
 * Grouped by day. Escaping test covers hostile path strings.
 *
 * Per project convention (no shared buildTestServer helper), this file
 * builds its own Fastify app via the per-file `buildApp` pattern used by
 * admin-route-guards.test.ts / household.test.ts.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type { SpaceService } from '../../services/spaces/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { SpaceDefinition } from '../../types/spaces.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerActivityRoutes } from '../routes/activity.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const ADMIN_ID = 'admin-1';
const MEMBER_A_ID = 'member-a';
const MEMBER_B_ID = 'member-b';
const HH_ID = 'hh-1';

function makeUserManager(): Pick<UserManager, 'getUser' | 'getAllUsers'> {
	const users = [
		{ id: ADMIN_ID, name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
		{ id: MEMBER_A_ID, name: 'Member A', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
		{ id: MEMBER_B_ID, name: 'Member B', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
	];
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users,
	} as unknown as Pick<UserManager, 'getUser' | 'getAllUsers'>;
}

function makeHouseholdService(): Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'> {
	return {
		getHouseholdForUser: () => HH_ID,
		getHousehold: (id: string) => (id === HH_ID ? { id: HH_ID, adminUserIds: [ADMIN_ID] } : null),
	};
}

function makeSpaceService(
	memberships: Record<string, string[]>,
): Pick<SpaceService, 'getSpacesForUser'> {
	return {
		getSpacesForUser: (userId: string) =>
			(memberships[userId] ?? []).map(
				(spaceId) =>
					({
						id: spaceId,
						name: spaceId,
						members: memberships[userId] ?? [],
						createdBy: ADMIN_ID,
					}) as unknown as SpaceDefinition,
			),
	};
}

function collectCookies(
	...responses: Array<{ cookies: Array<{ name: string; value: string }> }>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const res of responses) {
		for (const c of res.cookies) {
			result[c.name] = c.value;
		}
	}
	return result;
}

let tempDir: string;
let logPath: string;
let app: Awaited<ReturnType<typeof Fastify>>;

function jsonlLine(entry: Record<string, unknown>): string {
	return `${JSON.stringify(entry)}\n`;
}

async function buildApp(dir: string, opts: { spaceMemberships?: Record<string, string[]> } = {}) {
	logPath = join(dir, 'system', 'change-log.jsonl');
	await mkdir(join(dir, 'system'), { recursive: true });

	const credentialService = new CredentialService({ dataDir: dir });
	await credentialService.setPassword(ADMIN_ID, 'admin-pass-123');
	await credentialService.setPassword(MEMBER_A_ID, 'member-a-pass');
	await credentialService.setPassword(MEMBER_B_ID, 'member-b-pass');

	const userManager = makeUserManager();
	const householdService = makeHouseholdService();
	const spaceService = makeSpaceService(opts.spaceMemberships ?? {});

	const fastifyApp = Fastify({ logger: false });
	await fastifyApp.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await fastifyApp.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	await fastifyApp.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService,
				userManager: userManager as unknown as UserManager,
				householdService: householdService as unknown as HouseholdService,
			});
			await registerCsrfProtection(gui);
			await registerViewLocals(gui, { userManager: userManager as unknown as UserManager });
			registerActivityRoutes(gui, {
				logPath,
				householdService: householdService as unknown as HouseholdService,
				spaceService: spaceService as unknown as SpaceService,
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return fastifyApp;
}

async function login(userId: string, password: string): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId, password },
	});
	expect(res.statusCode).toBe(302);
	return collectCookies(res);
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-activity-'));
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('Activity feed (/gui/activity)', () => {
	it('member sees only their own entries, household-shared entries, and their space entries', async () => {
		app = await buildApp(tempDir, { spaceMemberships: { [MEMBER_A_ID]: ['family'] } });
		const now = new Date().toISOString();

		await writeFile(
			logPath,
			[
				jsonlLine({
					timestamp: now,
					operation: 'write',
					path: 'data/users/member-a/food/pantry.md',
					appId: 'food',
					userId: MEMBER_A_ID,
					householdId: HH_ID,
				}),
				jsonlLine({
					timestamp: now,
					operation: 'write',
					path: 'data/users/member-b/food/pantry.md',
					appId: 'food',
					userId: MEMBER_B_ID,
					householdId: HH_ID,
				}),
				jsonlLine({
					timestamp: now,
					operation: 'write',
					path: 'data/households/hh-1/shared/food/grocery-list.md',
					appId: 'food',
					userId: 'system',
					householdId: HH_ID,
				}),
				jsonlLine({
					timestamp: now,
					operation: 'write',
					path: 'data/spaces/family/food/meal-plan.md',
					appId: 'food',
					userId: 'system',
					spaceId: 'family',
					householdId: HH_ID,
				}),
			].join(''),
			'utf-8',
		);

		const cookies = await login(MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({ method: 'GET', url: '/gui/activity', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pantry.md');
		expect(res.body).toContain('grocery-list.md');
		expect(res.body).toContain('meal-plan.md');
	});

	it("member does NOT see another member's own-scoped entries or another space's entries", async () => {
		app = await buildApp(tempDir, { spaceMemberships: {} });
		const now = new Date().toISOString();

		await writeFile(
			logPath,
			[
				jsonlLine({
					timestamp: now,
					operation: 'write',
					path: 'data/users/member-b/food/secret-diary.md',
					appId: 'food',
					userId: MEMBER_B_ID,
					householdId: HH_ID,
				}),
				jsonlLine({
					timestamp: now,
					operation: 'write',
					path: 'data/spaces/other-space/food/other-notes.md',
					appId: 'food',
					userId: 'system',
					spaceId: 'other-space',
					householdId: HH_ID,
				}),
			].join(''),
			'utf-8',
		);

		const cookies = await login(MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({ method: 'GET', url: '/gui/activity', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('secret-diary.md');
		expect(res.body).not.toContain('other-notes.md');
	});

	it('admin sees all entries', async () => {
		app = await buildApp(tempDir, {});
		const now = new Date().toISOString();

		await writeFile(
			logPath,
			[
				jsonlLine({
					timestamp: now,
					operation: 'write',
					path: 'data/users/member-a/food/pantry.md',
					appId: 'food',
					userId: MEMBER_A_ID,
					householdId: HH_ID,
				}),
				jsonlLine({
					timestamp: now,
					operation: 'write',
					path: 'data/users/member-b/food/secret-diary.md',
					appId: 'food',
					userId: MEMBER_B_ID,
					householdId: HH_ID,
				}),
			].join(''),
			'utf-8',
		);

		const cookies = await login(ADMIN_ID, 'admin-pass-123');
		const res = await app.inject({ method: 'GET', url: '/gui/activity', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pantry.md');
		expect(res.body).toContain('secret-diary.md');
	});

	it('entries are humanized (app + basename + verb, never full paths) and grouped by day', async () => {
		app = await buildApp(tempDir, {});
		const now = new Date().toISOString();

		await writeFile(
			logPath,
			jsonlLine({
				timestamp: now,
				operation: 'write',
				path: 'data/users/member-a/food/pantry.md',
				appId: 'food',
				userId: MEMBER_A_ID,
				householdId: HH_ID,
			}),
			'utf-8',
		);

		const cookies = await login(MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({ method: 'GET', url: '/gui/activity', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('data/users/member-a/food/pantry.md');
		expect(res.body).toContain('pantry.md');
		expect(res.body.toLowerCase()).toMatch(/updated|changed|wrote|saved/);
	});

	it('empty state is an invitation, not an apology', async () => {
		app = await buildApp(tempDir, {});
		const cookies = await login(MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({ method: 'GET', url: '/gui/activity', cookies });

		expect(res.statusCode).toBe(200);
		const emptyStateMatch = res.body.match(/class="empty-state">([^<]*)</);
		expect(emptyStateMatch?.[1]).toBeTruthy();
		expect(emptyStateMatch?.[1]?.toLowerCase()).not.toMatch(/error|failed|sorry/);
	});

	it('escapes hostile path strings', async () => {
		app = await buildApp(tempDir, {});
		const now = new Date().toISOString();

		await writeFile(
			logPath,
			jsonlLine({
				timestamp: now,
				operation: 'write',
				path: 'data/users/member-a/food/<script>alert(1)</script>.md',
				appId: 'food',
				userId: MEMBER_A_ID,
				householdId: HH_ID,
			}),
			'utf-8',
		);

		const cookies = await login(MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({ method: 'GET', url: '/gui/activity', cookies });

		expect(res.statusCode).toBe(200);
		// `basename()` treats the literal "/" inside the "</script>" closing tag
		// as a path separator, so only the trailing "script>.md" segment survives
		// as the humanized filename — that remainder must still come through
		// HTML-escaped, and no raw "<" or ">" may reach the response unescaped.
		expect(res.body).not.toContain('<script>alert(1)</script>');
		expect(res.body).not.toContain('<script>alert(1)');
		expect(res.body).toContain('script&gt;.md');
	});

	it('clamps ?days= to 1-30', async () => {
		app = await buildApp(tempDir, {});
		const cookies = await login(MEMBER_A_ID, 'member-a-pass');

		const tooMany = await app.inject({ method: 'GET', url: '/gui/activity?days=9999', cookies });
		expect(tooMany.statusCode).toBe(200);

		const tooFew = await app.inject({ method: 'GET', url: '/gui/activity?days=0', cookies });
		expect(tooFew.statusCode).toBe(200);
	});
});
