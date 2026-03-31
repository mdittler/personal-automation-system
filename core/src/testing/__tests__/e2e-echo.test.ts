/**
 * E2E integration test: full pipeline from router to echo app.
 *
 * Uses real DataStore on a temp directory, mocked Telegram and LLM,
 * and loads the echo app via AppRegistry to prove the full round-trip.
 */

import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRegistry, type ServiceFactory } from '../../services/app-registry/index.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import { DataStoreServiceImpl } from '../../services/data-store/index.js';
import { FallbackHandler } from '../../services/router/fallback.js';
import { Router } from '../../services/router/index.js';
import type { CoreServices } from '../../types/app-module.js';
import type { SystemConfig } from '../../types/config.js';
import type { LLMService } from '../../types/llm.js';
import type { TelegramService } from '../../types/telegram.js';
import { createTestMessageContext } from '../test-helpers.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

function createMockTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
	};
}

function createMockLLM(): LLMService {
	return {
		complete: vi.fn().mockResolvedValue(''),
		classify: vi.fn().mockResolvedValue({ category: 'echo', confidence: 0.9 }),
		extractStructured: vi.fn().mockResolvedValue({}),
	};
}

function createTestConfig(overrides?: Partial<SystemConfig>): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp',
		logLevel: 'debug',
		timezone: 'UTC',
		telegram: { botToken: 'test-token' },
		ollama: { url: 'http://localhost:11434', model: 'test' },
		claude: { apiKey: 'test-key', model: 'test-model' },
		gui: { authToken: 'test-gui-token' },
		cloudflare: {},
		users: [
			{
				id: 'test-user',
				name: 'Test User',
				isAdmin: true,
				enabledApps: ['*'],
				sharedScopes: [],
			},
		],
		...overrides,
	};
}

describe('E2E: Echo App Pipeline', () => {
	let tempDir: string;
	let logger: Logger;
	let telegram: TelegramService;
	let llm: LLMService;
	let registry: AppRegistry;
	let router: Router;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-e2e-'));
		logger = createMockLogger();
		telegram = createMockTelegram();
		llm = createMockLLM();

		const changeLog = new ChangeLog(tempDir);
		const config = createTestConfig({ dataDir: tempDir });

		// Point the app registry at the real apps/echo directory
		const appsDir = resolve('apps');
		registry = new AppRegistry({ appsDir, config, logger });

		// Service factory: real DataStore, mock everything else
		const serviceFactory: ServiceFactory = (manifest, _appDir) => {
			const appId = manifest.app.id;
			const dataStore = new DataStoreServiceImpl({
				dataDir: tempDir,
				appId,
				userScopes: manifest.requirements?.data?.user_scopes ?? [],
				sharedScopes: manifest.requirements?.data?.shared_scopes ?? [],
				changeLog,
			});

			return {
				telegram,
				llm,
				data: dataStore,
				scheduler: {
					scheduleOnce: vi.fn().mockResolvedValue(undefined),
					cancelOnce: vi.fn().mockResolvedValue(undefined),
				},
				conditionEvaluator: {
					evaluate: vi.fn().mockResolvedValue(false),
					getRuleStatus: vi.fn().mockResolvedValue({
						id: '',
						lastFired: null,
						cooldownRemaining: 0,
						isActive: true,
					}),
				},
				audio: {
					speak: vi.fn().mockResolvedValue(undefined),
					tts: vi.fn().mockResolvedValue(Buffer.alloc(0)),
				},
				eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
				contextStore: {
					get: vi.fn().mockResolvedValue(null),
					search: vi.fn().mockResolvedValue([]),
				},
				config: {
					get: vi.fn().mockResolvedValue(undefined),
					getAll: vi.fn().mockResolvedValue({}),
				},
				logger: createMockLogger() as unknown as CoreServices['logger'],
			} as CoreServices;
		};

		await registry.loadAll(serviceFactory);

		const fallback = new FallbackHandler({
			dataDir: tempDir,
			timezone: 'UTC',
			logger,
		});

		router = new Router({
			registry,
			llm,
			telegram,
			fallback,
			config,
			logger,
		});
		router.buildRoutingTables();
	});

	afterEach(async () => {
		await registry.shutdownAll();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('should load the echo app', () => {
		expect(registry.getLoadedAppIds()).toContain('echo');
	});

	it('should route /echo command and send response', async () => {
		const ctx = createTestMessageContext({ text: '/echo hello world' });

		await router.routeMessage(ctx);

		expect(telegram.send).toHaveBeenCalledWith('test-user', 'hello world');
	});

	it('should write echo log to data store on /echo command', async () => {
		const ctx = createTestMessageContext({ text: '/echo test data' });

		await router.routeMessage(ctx);

		const logPath = join(tempDir, 'users', 'test-user', 'echo', 'log.md');
		const content = await readFile(logPath, 'utf-8');
		expect(content).toContain('/echo test data');
	});

	it('should reject messages from unregistered users', async () => {
		const ctx = createTestMessageContext({ userId: 'unknown-user', text: '/echo test' });

		await router.routeMessage(ctx);

		expect(telegram.send).toHaveBeenCalledWith(
			'unknown-user',
			'You are not authorized to use this bot.',
		);
	});
});
