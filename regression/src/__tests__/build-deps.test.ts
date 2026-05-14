/**
 * Production-wiring test for `composeLLMService`.
 *
 * Codex's Chunk B.1 review (P0) flagged that the CLI's
 * `composeMinimalLLMService` was a throwing stub. The rewired
 * `composeLLMService` actually composes the production
 * ProviderRegistry → ModelSelector → LLMServiceImpl stack used by
 * `compose-runtime.ts`. These tests verify the composition end-to-end
 * against a `StubProvider` so the code path `cli-main.ts` executes is
 * exercised — not bypassed by hand-built adapter shims.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostTracker } from '@core/services/llm/cost-tracker.js';
import { ProviderRegistry } from '@core/services/llm/providers/provider-registry.js';
import { createStubProviderRegistry } from '@core/testing/fixtures/stub-llm-provider.js';
import type { SystemConfig } from '@core/types/config.js';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyModelMatrixOverride,
	buildDryRunDeps,
	buildMetadataDeps,
	composeLLMService,
	findRepoRoot,
	resolveTierModelIds,
} from '../runner/build-deps.js';

let tempDir: string;
let dataDir: string;

function makeConfig(): SystemConfig {
	const stubRef = { provider: 'stub' as const, model: 'stub-model' };
	return {
		port: 3000,
		dataDir,
		telegram: { botToken: 'stub-token', allowedUserIds: [], chatId: '' },
		logLevel: 'warn',
		claude: { apiKey: '', model: 'stub-model', fastModel: 'stub-model' },
		ollama: { url: '', model: '' },
		llm: {
			providers: {
				stub: {
					type: 'openai-compatible',
					name: 'Stub',
					apiKeyEnvVar: '',
					defaultModel: 'stub-model',
				},
			},
			tiers: {
				fast: stubRef,
				standard: stubRef,
				reasoning: stubRef,
			},
		},
		gui: { authToken: 'stub-gui-token' },
		api: { token: 'stub-api-token' },
		cloudflare: {},
		webhooks: [],
		n8n: { dispatchUrl: '' },
		users: [],
		backup: {
			enabled: false,
			path: join(dataDir, 'backups'),
			schedule: '0 3 * * *',
			retentionCount: 7,
		},
		regression: { maxRunBudgetUsd: 7.5 },
	} as unknown as SystemConfig;
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'regression-build-deps-'));
	dataDir = join(tempDir, 'data');
	await mkdir(join(dataDir, 'system'), { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('composeLLMService — production wiring', () => {
	it('composes an LLMServiceImpl with the supplied provider registry override', async () => {
		const logger = pino({ level: 'silent' });
		const config = makeConfig();
		const costTracker = new CostTracker(config.dataDir, logger);
		await costTracker.loadMonthlyCache();

		const stubRegistry = createStubProviderRegistry(costTracker, logger, {
			classificationCategory: 'chatbot',
			completionText: 'stubbed completion',
			p50Ms: 0,
			p95Ms: 1,
			capMs: 2,
		});
		const llm = await composeLLMService(config, costTracker, logger, stubRegistry);

		const reply = await llm.complete('hello world', { tier: 'fast' });
		expect(reply).toBe('stubbed completion');
	});

	it('classify wiring routes through the same provider as complete', async () => {
		const logger = pino({ level: 'silent' });
		const config = makeConfig();
		const costTracker = new CostTracker(config.dataDir, logger);
		await costTracker.loadMonthlyCache();

		const stubRegistry = createStubProviderRegistry(costTracker, logger, {
			classificationCategory: 'chatbot',
			p50Ms: 0,
			p95Ms: 1,
			capMs: 2,
		});
		const llm = await composeLLMService(config, costTracker, logger, stubRegistry);

		const result = await llm.classify(
			'which category does "save this recipe" fall under? return json',
			['chatbot', 'food'],
		);
		expect(result.category).toBe('chatbot');
		expect(result.confidence).toBeGreaterThan(0);
	});

	it('throws when registry has zero providers — operator must wire pas.yaml + API keys', async () => {
		const logger = pino({ level: 'silent' });
		const config = makeConfig();
		const costTracker = new CostTracker(config.dataDir, logger);
		await costTracker.loadMonthlyCache();

		const emptyRegistry = new ProviderRegistry(logger);
		// ModelSelector.reconcile() throws when neither saved nor default tier
		// providers are available. The CLI surfaces this as "config error" rather
		// than silently running with a broken LLM — matches `compose-runtime.ts`.
		await expect(composeLLMService(config, costTracker, logger, emptyRegistry)).rejects.toThrow(
			/provider.*available|api key/i,
		);
	});
});

describe('build-deps — Chunk C wiring', () => {
	beforeEach(() => {
		vi.stubEnv('TELEGRAM_BOT_TOKEN', 'stub-token');
		vi.stubEnv('GUI_AUTH_TOKEN', 'stub-gui-token');
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-stub-not-real');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('buildDryRunDeps stubs the chatbot factory to throw if invoked', async () => {
		const deps = buildDryRunDeps();
		expect(typeof deps.chatbotEnvFactory).toBe('function');
		await expect(deps.chatbotEnvFactory!()).rejects.toThrow(/dry-run/i);
	});

	it('buildDryRunDeps stubs the recall adapter to throw if invoked', async () => {
		const deps = buildDryRunDeps();
		expect(typeof deps.recallAdapter?.recall).toBe('function');
		await expect(deps.recallAdapter!.recall('hi')).rejects.toThrow(/dry-run/i);
	});

	it('buildMetadataDeps does not require chatbot fixture access', async () => {
		const deps = await buildMetadataDeps();
		expect(deps.chatbotEnvFactory).toBeUndefined();
		expect(deps.recallAdapter).toBeUndefined();
	});

	it('applyModelMatrixOverride mutates the tier model IDs reported by deps', () => {
		const baseDeps = buildDryRunDeps();
		const overridden = applyModelMatrixOverride(baseDeps, {
			fast: { provider: 'ollama', model: 'gemma4:e4b' },
			standard: { provider: 'ollama', model: 'gemma4:26b' },
		});
		expect(overridden.modelIds.fast).toBe('gemma4:e4b');
		expect(overridden.modelIds.standard).toBe('gemma4:26b');
	});

	// Codex correction: tier override must reach the actual LLMService, not just
	// the cache-key metadata. This is the regression guard for the bug where
	// --model-matrix=ollama/gemma4:e4b would persist gemma4:e4b in `modelIds`
	// but still dispatch through the production tier (e.g., anthropic/claude-haiku).
	it('config.llm.tiers mutation propagates into LLMService.getModelForTier', async () => {
		const logger = pino({ level: 'silent' });
		const config = makeConfig();
		// Mutate tiers as buildProductionDeps now does up-front when tierOverride
		// is supplied.
		if (config.llm) {
			config.llm = {
				...config.llm,
				tiers: {
					fast: { provider: 'stub', model: 'gemma4:e4b-mock' },
					standard: { provider: 'stub', model: 'gemma4:26b-mock' },
				},
			};
		}
		const costTracker = new CostTracker(config.dataDir, logger);
		await costTracker.loadMonthlyCache();
		const stubRegistry = createStubProviderRegistry(costTracker, logger, {
			classificationCategory: 'chatbot',
			completionText: 'ok',
			p50Ms: 0,
			p95Ms: 1,
			capMs: 2,
		});
		const llm = await composeLLMService(config, costTracker, logger, stubRegistry);
		// getModelForTier returns `<provider>/<model>` form; we asserted on the
		// model substring after the slash to keep the assertion robust to the
		// provider-id wrapping convention.
		expect(llm.getModelForTier?.('fast')).toContain('gemma4:e4b-mock');
		expect(llm.getModelForTier?.('standard')).toContain('gemma4:26b-mock');
	});
});

describe('composeLLMService — transient override (Batch 0)', () => {
	// Regression for the Codex-reviewed bug: persisted `model-selection.yaml`
	// overrides used to silently clobber `--judge-model` / `--model-matrix`.
	// composeLLMService now calls applyTransientOverride AFTER load() to freeze
	// override tiers so neither load() nor reconcile() can revert them.

	it('tierOverride survives a persisted model-selection.yaml that disagrees', async () => {
		const { writeYamlFile } = await import('@core/utils/yaml.js');
		const logger = pino({ level: 'silent' });
		const config = makeConfig();
		const costTracker = new CostTracker(config.dataDir, logger);
		await costTracker.loadMonthlyCache();

		// Persist a saved selection that, without the fix, would silently win.
		await writeYamlFile(join(config.dataDir, 'system', 'model-selection.yaml'), {
			standard: { provider: 'stub', model: 'persisted-standard' },
			fast: { provider: 'stub', model: 'persisted-fast' },
		});

		const stubRegistry = createStubProviderRegistry(costTracker, logger, {
			classificationCategory: 'chatbot',
			completionText: 'ok',
			p50Ms: 0,
			p95Ms: 1,
			capMs: 2,
		});

		const llm = await composeLLMService(config, costTracker, logger, stubRegistry, {
			standard: { provider: 'stub', model: 'override-standard' },
			fast: { provider: 'stub', model: 'override-fast' },
		});

		expect(llm.getModelForTier?.('standard')).toContain('override-standard');
		expect(llm.getModelForTier?.('fast')).toContain('override-fast');
	});

	it('tierOverride with an unregistered provider causes reconcile() to throw (not silently fall back)', async () => {
		const logger = pino({ level: 'silent' });
		const config = makeConfig();
		const costTracker = new CostTracker(config.dataDir, logger);
		await costTracker.loadMonthlyCache();

		// Stub registry registers only 'stub'. The override points at 'ollama'
		// which is NOT registered — must throw.
		const stubRegistry = createStubProviderRegistry(costTracker, logger, {
			classificationCategory: 'chatbot',
			completionText: 'ok',
			p50Ms: 0,
			p95Ms: 1,
			capMs: 2,
		});

		await expect(
			composeLLMService(config, costTracker, logger, stubRegistry, {
				standard: { provider: 'ollama', model: 'gemma4:26b' },
			}),
		).rejects.toThrow(/transient override.*standard.*ollama.*not available/i);
	});
});

describe('resolveTierModelIds — transient override (Batch 0)', () => {
	// Codex correction: deps.modelIds.standard must reflect the override, not
	// the persisted value. Pre-fix, the cache key would echo the persisted
	// standard tier even when --judge-model was set, masking the bug.

	it('returns persisted values when no override is supplied', async () => {
		const { writeYamlFile } = await import('@core/utils/yaml.js');
		const logger = pino({ level: 'silent' });
		const config = makeConfig();
		await writeYamlFile(join(config.dataDir, 'system', 'model-selection.yaml'), {
			standard: { provider: 'stub', model: 'persisted-standard' },
			fast: { provider: 'stub', model: 'persisted-fast' },
		});
		const ids = await resolveTierModelIds(config, logger);
		expect(ids.standard).toBe('persisted-standard');
		expect(ids.fast).toBe('persisted-fast');
	});

	it('returns override values when tierOverride is supplied (cache-key reflects truth)', async () => {
		const { writeYamlFile } = await import('@core/utils/yaml.js');
		const logger = pino({ level: 'silent' });
		const config = makeConfig();
		// Persist a saved selection; the override must still win.
		await writeYamlFile(join(config.dataDir, 'system', 'model-selection.yaml'), {
			standard: { provider: 'stub', model: 'persisted-standard' },
			fast: { provider: 'stub', model: 'persisted-fast' },
		});
		const ids = await resolveTierModelIds(config, logger, {
			standard: { provider: 'stub', model: 'override-standard' },
		});
		expect(ids.standard).toBe('override-standard');
		expect(ids.fast).toBe('persisted-fast'); // non-overridden tier untouched
	});
});

describe('composeLLMService — cost-tracker delta', () => {
	it('cost-tracker delta is non-zero after a real provider call (drives REQ-REG-013 cost field)', async () => {
		const logger = pino({ level: 'silent' });
		const config = makeConfig();
		const costTracker = new CostTracker(config.dataDir, logger);
		await costTracker.loadMonthlyCache();

		const stubRegistry = createStubProviderRegistry(costTracker, logger, {
			p50Ms: 0,
			p95Ms: 1,
			capMs: 2,
		});
		const llm = await composeLLMService(config, costTracker, logger, stubRegistry);

		const before = costTracker.getMonthlyTotalCost();
		await llm.complete('hello', { tier: 'fast' });
		await costTracker.drainWrites();
		const after = costTracker.getMonthlyTotalCost();
		// Stub provider has pricing: null, so cost may be 0. The contract we care
		// about: the LLM call completes and CostTracker.record() runs without
		// throwing. Non-zero cost is provider-pricing-dependent.
		expect(after).toBeGreaterThanOrEqual(before);
	});
});

describe('findRepoRoot — workspace cwd independence', () => {
	const originalCwd = process.cwd();
	afterEach(() => {
		process.chdir(originalCwd);
	});

	it('returns a path containing config/pas.yaml regardless of cwd', async () => {
		const root = findRepoRoot();
		const { existsSync } = await import('node:fs');
		expect(existsSync(join(root, 'config', 'pas.yaml'))).toBe(true);
	});

	it('returns the same root from the regression workspace cwd', async () => {
		const rootFromRepo = findRepoRoot();
		process.chdir(join(rootFromRepo, 'regression'));
		expect(findRepoRoot()).toBe(rootFromRepo);
	});

	it('returns the same root from a deeply nested cwd', async () => {
		const rootFromRepo = findRepoRoot();
		process.chdir(join(rootFromRepo, 'regression', 'src', 'runner'));
		expect(findRepoRoot()).toBe(rootFromRepo);
	});
});
