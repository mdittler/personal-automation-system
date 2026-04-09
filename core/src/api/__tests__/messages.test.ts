import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { getCurrentUserId } from '../../services/context/request-context.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import { registerApiRoutes } from '../index.js';

const API_TOKEN = 'test-api-secret';

function createMockUserManager(registeredIds: string[] = ['user1']) {
	return {
		isRegistered: vi.fn((id: string) => registeredIds.includes(id)),
		getUser: vi.fn(),
		getUsers: vi.fn(() => []),
		validateConfig: vi.fn(() => []),
		getUserByName: vi.fn(),
	};
}

function createMockSpaceService() {
	return {
		isMember: vi.fn(),
		getSpace: vi.fn(),
		getAllSpaces: vi.fn(() => []),
		saveSpace: vi.fn(),
		deleteSpace: vi.fn(),
		addMember: vi.fn(),
		removeMember: vi.fn(),
		setActiveSpace: vi.fn(),
		getActiveSpace: vi.fn(),
		clearActiveSpace: vi.fn(),
		init: vi.fn(),
	};
}

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
} as any;

describe('API Messages Route', () => {
	let app: ReturnType<typeof Fastify>;
	let mockRouter: { routeMessage: ReturnType<typeof vi.fn> };

	beforeEach(async () => {
		mockRouter = {
			routeMessage: vi.fn(),
			routePhoto: vi.fn(),
			buildRoutingTables: vi.fn(),
		} as any;

		app = Fastify({ logger: false });
		await registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir: '/tmp/test',
			changeLog: new ChangeLog('/tmp/test'),
			spaceService: createMockSpaceService() as any,
			userManager: createMockUserManager() as any,
			router: mockRouter as any,
			cronManager: {
				getJobDetails: vi.fn(() => []),
				register: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
				unregister: vi.fn(),
				getRegisteredJobs: vi.fn(() => []),
			} as any,
			timezone: 'America/New_York',
			reportService: {
				listReports: vi.fn(() => []),
				getReport: vi.fn(),
				run: vi.fn(),
				saveReport: vi.fn(),
				deleteReport: vi.fn(),
				init: vi.fn(),
			} as any,
			alertService: {
				listAlerts: vi.fn(() => []),
				getAlert: vi.fn(),
				evaluate: vi.fn(),
				saveAlert: vi.fn(),
				deleteAlert: vi.fn(),
				init: vi.fn(),
			} as any,
			telegram: { send: vi.fn(), sendPhoto: vi.fn(), sendOptions: vi.fn() } as any,
			llm: {
				complete: vi.fn(() => 'mock response'),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			} as any,
			logger,
		});
	});

	afterEach(async () => {
		await app.close();
	});

	function post(body: Record<string, unknown>) {
		return app.inject({
			method: 'POST',
			url: '/api/messages',
			headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
			payload: body,
		});
	}

	it('valid message dispatched through router', async () => {
		const res = await post({ userId: 'user1', text: 'Hello PAS' });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true, dispatched: true });

		expect(mockRouter.routeMessage).toHaveBeenCalledOnce();
		const ctx = mockRouter.routeMessage.mock.calls[0][0];
		expect(ctx.userId).toBe('user1');
		expect(ctx.text).toBe('Hello PAS');
		expect(ctx.chatId).toBe(0);
		expect(ctx.messageId).toBe(0);
	});

	it('dispatches inside requestContext so config.get resolves per-user', async () => {
		// Regression guard for the per-user config runtime propagation fix.
		// The API route must wrap router.routeMessage in requestContext.run
		// so that AppConfigService.get() resolves to the caller's overrides
		// when the router ultimately invokes an app handler. Breaking this
		// wrap is invisible from the outside — the only observable symptom
		// is that every config.get silently returns the manifest default.
		let seenUserId: string | undefined = 'SENTINEL';
		mockRouter.routeMessage.mockImplementationOnce(async () => {
			seenUserId = getCurrentUserId();
		});

		const res = await post({ userId: 'user1', text: 'Hello PAS' });
		expect(res.statusCode).toBe(200);
		expect(seenUserId).toBe('user1');
	});

	it('message context includes timestamp', async () => {
		await post({ userId: 'user1', text: 'test' });
		const ctx = mockRouter.routeMessage.mock.calls[0][0];
		expect(ctx.timestamp).toBeInstanceOf(Date);
	});

	it('missing text returns 400', async () => {
		const res = await post({ userId: 'user1' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('text');
	});

	it('empty text returns 400', async () => {
		const res = await post({ userId: 'user1', text: '   ' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('empty');
	});

	it('text over 4096 chars returns 400', async () => {
		const res = await post({ userId: 'user1', text: 'x'.repeat(4097) });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('4096');
	});

	it('missing userId returns 400', async () => {
		const res = await post({ text: 'hello' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('userId');
	});

	it('unregistered userId returns 403', async () => {
		const res = await post({ userId: 'unknown', text: 'hello' });
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toContain('Unregistered');
	});

	it('router error caught and returns 500', async () => {
		mockRouter.routeMessage.mockRejectedValueOnce(new Error('Router boom'));
		const res = await post({ userId: 'user1', text: 'trigger error' });
		expect(res.statusCode).toBe(500);
		expect(res.json().ok).toBe(false);
	});

	it('text at exactly 4096 chars is accepted', async () => {
		const res = await post({ userId: 'user1', text: 'x'.repeat(4096) });
		expect(res.statusCode).toBe(200);
	});

	it('userId with path traversal chars returns 400', async () => {
		const res = await post({ userId: '../../etc', text: 'hello' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('userId');
	});

	it('non-string text returns 400', async () => {
		const res = await post({ userId: 'user1', text: 123 });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('text');
	});
});
