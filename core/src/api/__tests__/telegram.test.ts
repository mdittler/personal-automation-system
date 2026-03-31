import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import { registerApiRoutes } from '../index.js';

const API_TOKEN = 'test-api-secret';

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
} as any;

function createMocks() {
	return {
		userManager: {
			isRegistered: vi.fn((id: string) => id === 'user1'),
			getUser: vi.fn(),
			getUsers: vi.fn(() => []),
			validateConfig: vi.fn(() => []),
			getUserByName: vi.fn(),
		},
		spaceService: {
			isMember: vi.fn(() => false),
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
		},
		router: { routeMessage: vi.fn(), routePhoto: vi.fn(), buildRoutingTables: vi.fn() },
		cronManager: {
			getJobDetails: vi.fn(() => []),
			register: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			unregister: vi.fn(),
			getRegisteredJobs: vi.fn(() => []),
		},
		reportService: {
			listReports: vi.fn(() => []),
			getReport: vi.fn(),
			run: vi.fn(),
			saveReport: vi.fn(),
			deleteReport: vi.fn(),
			init: vi.fn(),
		},
		alertService: {
			listAlerts: vi.fn(() => []),
			getAlert: vi.fn(),
			evaluate: vi.fn(),
			saveAlert: vi.fn(),
			deleteAlert: vi.fn(),
			init: vi.fn(),
		},
		llm: { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() },
	};
}

describe('API Telegram Route', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;
	let mockTelegram: any;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-telegram-'));
		const mocks = createMocks();

		mockTelegram = {
			send: vi.fn(),
			sendPhoto: vi.fn(),
			sendOptions: vi.fn(),
		};

		app = Fastify({ logger: false });
		await registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir,
			changeLog: new ChangeLog(dataDir),
			spaceService: mocks.spaceService as any,
			userManager: mocks.userManager as any,
			router: mocks.router as any,
			cronManager: mocks.cronManager as any,
			timezone: 'America/New_York',
			logger,
			reportService: mocks.reportService as any,
			alertService: mocks.alertService as any,
			telegram: mockTelegram,
			llm: mocks.llm as any,
		});
	});

	afterEach(async () => {
		await app?.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	function authHeaders() {
		return { authorization: `Bearer ${API_TOKEN}` };
	}

	it('sends a message to a registered user', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/telegram/send',
			headers: authHeaders(),
			payload: { userId: 'user1', message: 'Hello!' },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().ok).toBe(true);
		expect(res.json().sent).toBe(true);
		expect(mockTelegram.send).toHaveBeenCalledWith('user1', 'Hello!');
	});

	it('returns 400 for missing userId', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/telegram/send',
			headers: authHeaders(),
			payload: { message: 'Hello!' },
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 400 for missing message', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/telegram/send',
			headers: authHeaders(),
			payload: { userId: 'user1' },
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 400 for empty message', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/telegram/send',
			headers: authHeaders(),
			payload: { userId: 'user1', message: '   ' },
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 400 for invalid userId format', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/telegram/send',
			headers: authHeaders(),
			payload: { userId: '../evil', message: 'Hello!' },
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 403 for unregistered user', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/telegram/send',
			headers: authHeaders(),
			payload: { userId: 'unknown-user', message: 'Hello!' },
		});
		expect(res.statusCode).toBe(403);
	});

	it('returns 400 for oversized message', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/telegram/send',
			headers: authHeaders(),
			payload: { userId: 'user1', message: 'x'.repeat(4097) },
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 500 on telegram send error', async () => {
		mockTelegram.send.mockRejectedValue(new Error('Bot API error'));
		const res = await app.inject({
			method: 'POST',
			url: '/api/telegram/send',
			headers: authHeaders(),
			payload: { userId: 'user1', message: 'Hello!' },
		});
		expect(res.statusCode).toBe(500);
	});

	it('requires authentication', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/telegram/send',
			payload: { userId: 'user1', message: 'Hello!' },
		});
		expect(res.statusCode).toBe(401);
	});
});
