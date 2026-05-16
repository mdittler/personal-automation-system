/**
 * llama.cpp provider — composeRuntime() registration integration test.
 *
 * Exercises the real config → factory → registry path with a YAML-derived
 * config that includes the llama-cpp block from `config/pas.yaml.example`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the OpenAI SDK so LlamaCppProvider construction doesn't try to open a
// real socket; we just want to verify registration + provider shape.
vi.mock('openai', () => {
	class MockOpenAI {
		chat = { completions: { create: vi.fn() } };
		models = { list: vi.fn() };
		constructor(_options: unknown) {}
	}
	return { default: MockOpenAI };
});

import { composeRuntime, type RuntimeHandle } from '../compose-runtime.js';
import { fakeTelegramService } from '../testing/fixtures/fake-telegram.js';
import { seedUsers } from '../testing/fixtures/seed-users.js';

const logger = pino({ level: 'silent' });

describe('llama.cpp via composeRuntime (REQ-LLM-LLAMA-CPP-007)', () => {
	let tempDir: string;
	let runtime: RuntimeHandle | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-llama-cpp-compose-'));
	});

	afterEach(async () => {
		if (runtime) await runtime.dispose();
		runtime = undefined;
		vi.unstubAllEnvs();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('registers a llama-cpp provider when present in config.llm.providers', async () => {
		const seed = await seedUsers({ dataDir: tempDir, users: 1, households: 1 });

		// Pin every tier to llama-cpp + register a single llama-cpp provider —
		// this is the no-stub path that exercises the real factory.
		const localRef = { provider: 'llama-cpp', model: 'local-model' };
		seed.config.llm = {
			providers: {
				'llama-cpp': {
					type: 'llama-cpp',
					name: 'llama.cpp',
					apiKeyEnvVar: '',
					baseUrl: 'http://localhost:8080',
					defaultModel: 'local-model',
				},
			},
			tiers: { fast: localRef, standard: localRef, reasoning: localRef },
		};

		runtime = await composeRuntime({
			dataDir: join(tempDir, 'data'),
			configPath: seed.configPath,
			config: seed.config,
			telegramService: fakeTelegramService(),
			logger,
		});

		const provider = runtime.services.providerRegistry.get('llama-cpp');
		expect(provider).toBeDefined();
		expect(provider?.providerType).toBe('llama-cpp');
		expect(provider?.providerId).toBe('llama-cpp');
	});

	it('skips a llama-cpp provider that has no baseUrl (REQ-LLM-LLAMA-CPP-001 edge)', async () => {
		const seed = await seedUsers({ dataDir: tempDir, users: 1, households: 1 });

		// Use an anthropic stub to satisfy the tier-reconcile so we can isolate the
		// llama-cpp-with-no-baseUrl assertion without other failure modes.
		seed.config.llm = {
			providers: {
				anthropic: {
					type: 'anthropic',
					name: 'Anthropic',
					apiKeyEnvVar: 'ANTHROPIC_API_KEY_FAKE_FOR_TEST',
					defaultModel: 'claude-sonnet-4-20250514',
				},
				'llama-cpp': {
					type: 'llama-cpp',
					name: 'llama.cpp',
					apiKeyEnvVar: '',
					// baseUrl omitted — provider factory should return null
					defaultModel: 'local-model',
				},
			},
			tiers: {
				fast: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
				standard: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
				reasoning: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
			},
		};

		// Anthropic provider's constructor doesn't make a network call; an
		// empty-but-set key is fine. afterEach calls vi.unstubAllEnvs.
		vi.stubEnv('ANTHROPIC_API_KEY_FAKE_FOR_TEST', 'sk-ant-test-key');

		runtime = await composeRuntime({
			dataDir: join(tempDir, 'data'),
			configPath: seed.configPath,
			config: seed.config,
			telegramService: fakeTelegramService(),
			logger,
		});

		expect(runtime.services.providerRegistry.get('llama-cpp')).toBeUndefined();
		expect(runtime.services.providerRegistry.get('anthropic')).toBeDefined();
	});
});
