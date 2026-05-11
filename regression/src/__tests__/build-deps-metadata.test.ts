/**
 * Tests for `buildMetadataDeps()` (Chunk B.2 Codex C1 fix).
 *
 * The GUI's `--list` mode needs real tier model IDs so the emitted
 * `currentCacheKey` matches what `runSuite()` would write to cache. The
 * dry-run deps builder returns `modelIds: 'dry-run'`, which would break
 * coverage-/model-change detection on every real run. `buildMetadataDeps()`
 * resolves real IDs via `loadSystemConfig` + `ModelSelector` WITHOUT
 * composing providers or instantiating LLMService — fast, env-light, and
 * sufficient for cache-key computation.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMetadataDeps } from '../runner/build-deps.js';

let tempDir: string;
let configPath: string;
let dataDir: string;

const MIN_PAS_YAML = `
defaults:
  timezone: UTC
  log_level: warn
llm:
  providers:
    anthropic:
      type: anthropic
      name: Anthropic
      api_key_env: ANTHROPIC_API_KEY
      default_model: claude-sonnet-4-5
  tiers:
    fast:
      provider: anthropic
      model: claude-haiku-4-5-20251001
    standard:
      provider: anthropic
      model: claude-sonnet-4-5
backup:
  enabled: false
users:
  - id: test-user
    name: Test User
    household_id: test-household
`;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'regression-meta-deps-'));
	configPath = join(tempDir, 'pas.yaml');
	dataDir = join(tempDir, 'data');
	await mkdir(join(dataDir, 'system'), { recursive: true });
	await writeFile(configPath, MIN_PAS_YAML);
	vi.stubEnv('TELEGRAM_BOT_TOKEN', 'stub-token');
	vi.stubEnv('GUI_AUTH_TOKEN', 'stub-gui-token');
	vi.stubEnv('ANTHROPIC_API_KEY', 'sk-stub-not-real');
	vi.stubEnv('DATA_DIR', dataDir);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(tempDir, { recursive: true, force: true });
});

describe('buildMetadataDeps()', () => {
	it('returns real tier model IDs (not "dry-run" placeholders)', async () => {
		const deps = await buildMetadataDeps({ configPath });
		expect(deps.modelIds.fast).toBe('claude-haiku-4-5-20251001');
		expect(deps.modelIds.standard).toBe('claude-sonnet-4-5');
		expect(deps.modelIds.fast).not.toBe('dry-run');
		expect(deps.modelIds.standard).not.toBe('dry-run');
	});

	it('returns reasoning: null when pas.yaml omits the reasoning tier', async () => {
		const deps = await buildMetadataDeps({ configPath });
		expect(deps.modelIds.reasoning).toBeNull();
	});

	it('classifiers throw if invoked — list mode does not dispatch', async () => {
		const deps = await buildMetadataDeps({ configPath });
		await expect(deps.classifiers.foodShadow('hi')).rejects.toThrow(
			/metadata-only|list mode|dispatch/i,
		);
		await expect(deps.classifiers.sessionControl('hi')).rejects.toThrow(
			/metadata-only|list mode|dispatch/i,
		);
		await expect(deps.classifiers.pas('hi')).rejects.toThrow(/metadata-only|list mode|dispatch/i);
	});

	it('estimateUsd returns 0 — no LLM call is metered in list mode', async () => {
		const deps = await buildMetadataDeps({ configPath });
		expect(deps.estimateUsd({ tokenIn: 100, tokenOut: 50 })).toBe(0);
	});

	it('resolves repo paths (casesDir, cacheDir, repoRoot)', async () => {
		const deps = await buildMetadataDeps({ configPath });
		expect(deps.casesDir).toMatch(/regression\/src\/cases$/);
		expect(deps.cacheDir).toMatch(/data\/system\/regression-cache$/);
		expect(typeof deps.repoRoot).toBe('string');
	});

	it('honours regression.maxRunBudgetUsd default (5.00 USD) when not in config', async () => {
		const deps = await buildMetadataDeps({ configPath });
		expect(deps.maxRunBudgetUsd).toBe(5.0);
	});

	it('honours custom regression.maxRunBudgetUsd from pas.yaml', async () => {
		await writeFile(configPath, `${MIN_PAS_YAML}\nregression:\n  maxRunBudgetUsd: 12.34\n`);
		const deps = await buildMetadataDeps({ configPath });
		expect(deps.maxRunBudgetUsd).toBe(12.34);
	});

	it('falls back to env-default model IDs when pas.yaml omits the tier (still real, not "dry-run")', async () => {
		// Without an `llm.tiers` block in pas.yaml, model IDs resolve from the
		// CLAUDE_MODEL / CLAUDE_FAST_MODEL env defaults baked into loadSystemConfig.
		// The contract for B.2 is "same modelIds as `runSuite` would write" —
		// what matters is that the IDs are real strings, never the 'dry-run'
		// placeholder. (Cache-key parity then holds because buildProductionDeps
		// resolves them identically.)
		await writeFile(configPath, 'defaults:\n  timezone: UTC\n');
		const deps = await buildMetadataDeps({ configPath });
		expect(deps.modelIds.fast).not.toBe('dry-run');
		expect(deps.modelIds.standard).not.toBe('dry-run');
		expect(typeof deps.modelIds.fast).toBe('string');
		expect(typeof deps.modelIds.standard).toBe('string');
		expect(deps.modelIds.fast.length).toBeGreaterThan(0);
	});
});
