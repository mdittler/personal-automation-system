/**
 * Conversations browser (Batch 6, Task 6.1).
 *
 * `/gui/sessions` — read-only, own-sessions-ONLY for EVERY authenticated
 * user, including platform admins. Chat transcripts are personal; the
 * spec's "non-admins see only their own" floor is deliberately extended to
 * admins too (see docs/open-items.md — this is a locked decision, not an
 * oversight). Detail view 404s identically for another user's session id
 * and for an unknown id (no existence leak).
 *
 * Uses a REAL SQLite-backed ChatTranscriptIndex (same fixture pattern as
 * list-queries.test.ts) so listSessionsForUser/listMessagesForSession/
 * searchSessions are exercised for real, not stubbed.
 *
 * Per project convention (no shared buildTestServer helper), this file
 * builds its own Fastify app via the per-file `buildApp` pattern used by
 * admin-route-guards.test.ts / household.test.ts.
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
import { createChatTranscriptIndex } from '../../services/chat-transcript-index/index.js';
import type { ChatTranscriptIndex } from '../../services/chat-transcript-index/index.js';
import type { MessageRow, SessionRow } from '../../services/chat-transcript-index/types.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerSessionsRoutes } from '../routes/sessions.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const ADMIN_ID = 'admin-1';
const MEMBER_A_ID = 'member-a';
const MEMBER_B_ID = 'member-b';

function makeSession(overrides: Partial<SessionRow> & { id: string; user_id: string }): SessionRow {
	return {
		household_id: 'hh-1',
		source: 'telegram',
		started_at: '2026-01-01T00:00:00Z',
		ended_at: null,
		model: null,
		title: null,
		parent_session_id: null,
		...overrides,
	};
}

function makeMessage(overrides: Partial<MessageRow> & { session_id: string }): MessageRow {
	return {
		turn_index: 0,
		role: 'user',
		content: 'hello',
		timestamp: '2026-01-01T00:00:01Z',
		...overrides,
	};
}

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
		getHouseholdForUser: () => 'hh-1',
		getHousehold: (id: string) => (id === 'hh-1' ? { id: 'hh-1', adminUserIds: [ADMIN_ID] } : null),
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
let app: Awaited<ReturnType<typeof Fastify>>;
let index: ChatTranscriptIndex;

async function buildApp(dir: string) {
	index = createChatTranscriptIndex(join(dir, 'cti.db'));

	// Seed: admin has one session; member A has two; member B has one.
	await index.upsertSession(
		makeSession({
			id: 'admin-1-sess',
			user_id: ADMIN_ID,
			started_at: '2026-01-01T00:00:00Z',
			title: 'Admin session',
		}),
	);
	await index.appendMessage(
		makeMessage({ session_id: 'admin-1-sess', turn_index: 0, content: 'admin says hi' }),
	);

	await index.upsertSession(
		makeSession({
			id: 'a-1',
			user_id: MEMBER_A_ID,
			started_at: '2026-01-01T00:00:00Z',
			title: 'First chat',
		}),
	);
	await index.appendMessage(
		makeMessage({
			session_id: 'a-1',
			turn_index: 0,
			role: 'user',
			content: 'What is the weather about pantry items?',
			timestamp: '2026-01-01T00:00:01Z',
		}),
	);
	await index.appendMessage(
		makeMessage({
			session_id: 'a-1',
			turn_index: 1,
			role: 'assistant',
			content: '<script>alert(1)</script> here is your pantry summary',
			timestamp: '2026-01-01T00:00:02Z',
		}),
	);

	await index.upsertSession(
		makeSession({
			id: 'a-2',
			user_id: MEMBER_A_ID,
			started_at: '2026-01-02T00:00:00Z',
			title: 'Second chat',
		}),
	);
	await index.appendMessage(
		makeMessage({
			session_id: 'a-2',
			turn_index: 0,
			role: 'user',
			content: 'anything unrelated',
			timestamp: '2026-01-02T00:00:01Z',
		}),
	);

	await index.upsertSession(
		makeSession({
			id: 'b-1',
			user_id: MEMBER_B_ID,
			started_at: '2026-01-01T12:00:00Z',
			title: 'Bees',
		}),
	);
	await index.appendMessage(makeMessage({ session_id: 'b-1', turn_index: 0, content: 'buzz' }));

	const credentialService = new CredentialService({ dataDir: dir });
	await credentialService.setPassword(ADMIN_ID, 'admin-pass-123');
	await credentialService.setPassword(MEMBER_A_ID, 'member-a-pass');
	await credentialService.setPassword(MEMBER_B_ID, 'member-b-pass');

	const userManager = makeUserManager();
	const householdService = makeHouseholdService();

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
			registerSessionsRoutes(gui, {
				chatTranscriptIndex: index,
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
	tempDir = await mkdtemp(join(tmpdir(), 'pas-sessions-'));
	app = await buildApp(tempDir);
});

afterEach(async () => {
	await app.close();
	await index.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('Conversations browser (/gui/sessions)', () => {
	it('lists only the requesting member’s sessions (title, date, turn count)', async () => {
		const cookies = await login(MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({ method: 'GET', url: '/gui/sessions', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('First chat');
		expect(res.body).toContain('Second chat');
		expect(res.body).not.toContain('Bees');
		expect(res.body).not.toContain('Admin session');
	});

	it('admin also sees ONLY their own sessions (privacy: transcripts are personal)', async () => {
		const cookies = await login(ADMIN_ID, 'admin-pass-123');
		const res = await app.inject({ method: 'GET', url: '/gui/sessions', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Admin session');
		expect(res.body).not.toContain('First chat');
		expect(res.body).not.toContain('Second chat');
		expect(res.body).not.toContain('Bees');
	});

	it('search returns FTS matches scoped to the user', async () => {
		const cookies = await login(MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/sessions?q=pantry',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('First chat');
		// The other member's session must never appear, even if it matched.
		expect(res.body).not.toContain('Bees');
	});

	it('detail view renders messages read-only with all content HTML-escaped', async () => {
		const cookies = await login(MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({ method: 'GET', url: '/gui/sessions/a-1', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('<script>alert(1)</script>');
		expect(res.body).toContain('&lt;script&gt;');
		expect(res.body).toContain('pantry summary');
	});

	it('detail view 404s for another user’s session id (no existence leak: same 404 as unknown id)', async () => {
		const cookies = await login(MEMBER_A_ID, 'member-a-pass');

		const otherUsersSession = await app.inject({
			method: 'GET',
			url: '/gui/sessions/b-1',
			cookies,
		});
		const unknownSession = await app.inject({
			method: 'GET',
			url: '/gui/sessions/does-not-exist',
			cookies,
		});

		expect(otherUsersSession.statusCode).toBe(404);
		expect(unknownSession.statusCode).toBe(404);
		// Same shape — no leak that b-1 exists but belongs to someone else.
		// Strip the per-response CSRF token (double-submit cookie — legitimately
		// differs per request) before comparing the rest of the page.
		const stripCsrf = (body: string) =>
			body.replace(/name="_csrf" value="[^"]*"/g, '').replace(/content="[a-f0-9]{32,}"/g, '');
		expect(stripCsrf(otherUsersSession.body)).toBe(stripCsrf(unknownSession.body));
	});

	it('requires authentication', async () => {
		const res = await app.inject({ method: 'GET', url: '/gui/sessions' });
		expect(res.statusCode).toBe(302);
	});
});
