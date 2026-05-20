/**
 * Tests for SystemConfig.chat.memory.strict_durable_kinds
 *
 * Verifies:
 * - Default config has strict_durable_kinds === false
 * - Zod schema rejects non-boolean value
 * - Explicit strict_durable_kinds: true is accepted and accessible
 * - Explicit strict_durable_kinds: false is accepted
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
	tempDir = await mkdtemp(join(tmpdir(), 'pas-strict-durable-'));
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

describe('PasYamlConfigSchema — chat.memory.strict_durable_kinds', () => {
	it('accepts chat.memory.strict_durable_kinds: true', () => {
		const result = PasYamlConfigSchema.safeParse({
			chat: { memory: { strict_durable_kinds: true } },
		});
		expect(result.success).toBe(true);
	});

	it('accepts chat.memory.strict_durable_kinds: false', () => {
		const result = PasYamlConfigSchema.safeParse({
			chat: { memory: { strict_durable_kinds: false } },
		});
		expect(result.success).toBe(true);
	});

	it('accepts chat.memory absent (field is optional)', () => {
		const result = PasYamlConfigSchema.safeParse({ chat: {} });
		expect(result.success).toBe(true);
	});

	it('rejects non-boolean value for strict_durable_kinds', () => {
		const result = PasYamlConfigSchema.safeParse({
			chat: { memory: { strict_durable_kinds: 'yes' } },
		});
		expect(result.success).toBe(false);
	});

	it('rejects numeric value for strict_durable_kinds', () => {
		const result = PasYamlConfigSchema.safeParse({
			chat: { memory: { strict_durable_kinds: 1 } },
		});
		expect(result.success).toBe(false);
	});
});

describe('loadSystemConfig — chat.memory.strict_durable_kinds default', () => {
	it('default config has chat.memory.strict_durable_kinds === false', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, requiredEnvVars);
		// no pas.yaml — uses defaults

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
			mode: 'transitional',
		});

		expect(config.chat?.memory?.strict_durable_kinds).toBe(false);
	});

	it('explicit strict_durable_kinds: true is accessible on loaded config', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');
		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				users: [{ id: '1', name: 'Alice', household_id: 'hh-a' }],
				chat: {
					memory: {
						strict_durable_kinds: true,
					},
				},
			}),
			'utf-8',
		);

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });
		expect(config.chat?.memory?.strict_durable_kinds).toBe(true);
	});

	it('explicit strict_durable_kinds: false is accessible on loaded config', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');
		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				users: [{ id: '1', name: 'Alice', household_id: 'hh-a' }],
				chat: {
					memory: {
						strict_durable_kinds: false,
					},
				},
			}),
			'utf-8',
		);

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });
		expect(config.chat?.memory?.strict_durable_kinds).toBe(false);
	});
});
