/**
 * Tests for SystemConfig.regression.maxRunBudgetUsd
 *
 * REQ-REG-009 — per-run cost ceiling for the persona regression suite.
 *
 * Verifies:
 * - Default config has regression.maxRunBudgetUsd === 5.00
 * - Explicit override via YAML is honoured
 * - Zod schema rejects negative, NaN/Infinity, non-number values
 * - Top-level `regression` block can be omitted (loader fills default)
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadSystemConfig } from '../index.js';
import { PasYamlConfigSchema } from '../pas-yaml-schema.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-regression-config-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Minimal required env vars for a valid config. */
const requiredEnvVars = {
	TELEGRAM_BOT_TOKEN: 'test-bot-token',
	ANTHROPIC_API_KEY: 'test-api-key',
	GUI_AUTH_TOKEN: 'test-gui-token',
};

async function writeEnvFile(envPath: string, vars: Record<string, string>): Promise<void> {
	const content = Object.entries(vars)
		.map(([k, v]) => `${k}=${v}`)
		.join('\n');
	await writeFile(envPath, content, 'utf-8');
}

describe('PasYamlConfigSchema — regression.maxRunBudgetUsd', () => {
	it('accepts regression block with positive maxRunBudgetUsd', () => {
		const result = PasYamlConfigSchema.safeParse({
			regression: { maxRunBudgetUsd: 2.5 },
		});
		expect(result.success).toBe(true);
	});

	it('accepts top-level regression block absent', () => {
		const result = PasYamlConfigSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	it('accepts regression: {} (uses key default)', () => {
		const result = PasYamlConfigSchema.safeParse({ regression: {} });
		expect(result.success).toBe(true);
	});

	it('rejects negative maxRunBudgetUsd', () => {
		const result = PasYamlConfigSchema.safeParse({
			regression: { maxRunBudgetUsd: -1 },
		});
		expect(result.success).toBe(false);
	});

	it('rejects zero maxRunBudgetUsd (must be positive)', () => {
		const result = PasYamlConfigSchema.safeParse({
			regression: { maxRunBudgetUsd: 0 },
		});
		expect(result.success).toBe(false);
	});

	it('rejects NaN maxRunBudgetUsd', () => {
		const result = PasYamlConfigSchema.safeParse({
			regression: { maxRunBudgetUsd: Number.NaN },
		});
		expect(result.success).toBe(false);
	});

	it('rejects Infinity maxRunBudgetUsd', () => {
		const result = PasYamlConfigSchema.safeParse({
			regression: { maxRunBudgetUsd: Number.POSITIVE_INFINITY },
		});
		expect(result.success).toBe(false);
	});

	it('rejects non-number maxRunBudgetUsd (string)', () => {
		const result = PasYamlConfigSchema.safeParse({
			regression: { maxRunBudgetUsd: 'not a number' },
		});
		expect(result.success).toBe(false);
	});

	it('rejects null maxRunBudgetUsd', () => {
		const result = PasYamlConfigSchema.safeParse({
			regression: { maxRunBudgetUsd: null },
		});
		expect(result.success).toBe(false);
	});
});

describe('loadSystemConfig — regression.maxRunBudgetUsd default', () => {
	it('defaults regression.maxRunBudgetUsd to 5.00 when key absent', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, requiredEnvVars);
		// no pas.yaml — uses defaults

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
			mode: 'transitional',
		});

		expect(config.regression?.maxRunBudgetUsd).toBe(5.0);
	});

	it('defaults regression.maxRunBudgetUsd to 5.00 when regression block is empty', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');
		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				users: [{ id: '1', name: 'Alice', household_id: 'hh-a' }],
				regression: {},
			}),
			'utf-8',
		);

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });
		expect(config.regression?.maxRunBudgetUsd).toBe(5.0);
	});

	it('honours explicit regression.maxRunBudgetUsd override', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');
		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				users: [{ id: '1', name: 'Alice', household_id: 'hh-a' }],
				regression: { maxRunBudgetUsd: 2.5 },
			}),
			'utf-8',
		);

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });
		expect(config.regression?.maxRunBudgetUsd).toBe(2.5);
	});

	it('rejects negative regression.maxRunBudgetUsd at load time', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');
		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				users: [{ id: '1', name: 'Alice', household_id: 'hh-a' }],
				regression: { maxRunBudgetUsd: -1 },
			}),
			'utf-8',
		);

		await expect(loadSystemConfig({ envPath, configPath: yamlPath })).rejects.toThrow(
			/regression\.maxRunBudgetUsd/,
		);
	});

	it('rejects non-number regression.maxRunBudgetUsd at load time', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');
		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				users: [{ id: '1', name: 'Alice', household_id: 'hh-a' }],
				regression: { maxRunBudgetUsd: 'not a number' },
			}),
			'utf-8',
		);

		await expect(loadSystemConfig({ envPath, configPath: yamlPath })).rejects.toThrow(
			/regression\.maxRunBudgetUsd/,
		);
	});
});
