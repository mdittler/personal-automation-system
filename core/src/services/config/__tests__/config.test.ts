import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { loadSystemConfig } from '../index.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-config-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/**
 * Write a .env file with the given key-value pairs.
 */
async function writeEnvFile(envPath: string, vars: Record<string, string>): Promise<void> {
	const content = Object.entries(vars)
		.map(([key, value]) => `${key}=${value}`)
		.join('\n');
	await writeFile(envPath, content, 'utf-8');
}

/** Minimal required env vars for a valid config. */
const requiredEnvVars = {
	TELEGRAM_BOT_TOKEN: 'test-bot-token-123',
	ANTHROPIC_API_KEY: 'test-api-key-456',
	GUI_AUTH_TOKEN: 'test-gui-token-789',
};

describe('loadSystemConfig', () => {
	it('loads config from .env and pas.yaml', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				users: [
					{
						id: '111',
						name: 'Alice',
						is_admin: true,
						enabled_apps: ['*'],
						shared_scopes: ['family'],
					},
				],
				defaults: {
					log_level: 'debug',
					timezone: 'America/Chicago',
				},
			}),
			'utf-8',
		);

		const config = await loadSystemConfig({
			envPath,
			configPath: yamlPath,
		});

		expect(config.telegram.botToken).toBe('test-bot-token-123');
		expect(config.claude.apiKey).toBe('test-api-key-456');
		expect(config.gui.authToken).toBe('test-gui-token-789');
		expect(config.logLevel).toBe('debug');
		expect(config.timezone).toBe('America/Chicago');
		expect(config.users).toHaveLength(1);
		expect(config.users[0]?.name).toBe('Alice');
		expect(config.users[0]?.isAdmin).toBe(true);
		expect(config.users[0]?.enabledApps).toEqual(['*']);
		expect(config.users[0]?.sharedScopes).toEqual(['family']);
	});

	it('uses defaults when pas.yaml is missing', async () => {
		const envPath = join(tempDir, '.env');
		const missingYaml = join(tempDir, 'nonexistent.yaml');

		await writeEnvFile(envPath, requiredEnvVars);

		const config = await loadSystemConfig({
			envPath,
			configPath: missingYaml,
		});

		// Defaults from envalid
		expect(config.port).toBe(3000);
		expect(config.logLevel).toBe('info');
		expect(config.timezone).toBe('UTC');
		// Ollama is undefined when OLLAMA_URL is empty (default)
		expect(config.ollama).toBeUndefined();
		expect(config.users).toEqual([]);
	});

	it('uses env defaults for optional fields', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, requiredEnvVars);

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.port).toBe(3000);
		// Ollama is undefined when OLLAMA_URL is not set
		expect(config.ollama).toBeUndefined();
		expect(config.cloudflare.tunnelToken).toBeUndefined();
	});

	it('parses multiple users from YAML', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				users: [
					{ id: '111', name: 'Alice', is_admin: true },
					{ id: '222', name: 'Bob', is_admin: false, enabled_apps: ['grocery'] },
				],
			}),
			'utf-8',
		);

		const config = await loadSystemConfig({
			envPath,
			configPath: yamlPath,
		});

		expect(config.users).toHaveLength(2);
		expect(config.users[0]?.id).toBe('111');
		expect(config.users[0]?.isAdmin).toBe(true);
		expect(config.users[0]?.enabledApps).toEqual([]);
		expect(config.users[1]?.id).toBe('222');
		expect(config.users[1]?.isAdmin).toBe(false);
		expect(config.users[1]?.enabledApps).toEqual(['grocery']);
	});

	it('YAML log_level overrides env LOG_LEVEL', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, {
			...requiredEnvVars,
			LOG_LEVEL: 'warn',
		});
		await writeFile(yamlPath, stringify({ defaults: { log_level: 'trace' } }), 'utf-8');

		const config = await loadSystemConfig({
			envPath,
			configPath: yamlPath,
		});

		expect(config.logLevel).toBe('trace');
	});

	it('sets ollama config when OLLAMA_URL is provided', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, {
			...requiredEnvVars,
			OLLAMA_URL: 'http://localhost:11434',
			OLLAMA_MODEL: 'gemma2:2b',
		});

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.ollama).toBeDefined();
		expect(config.ollama?.url).toBe('http://localhost:11434');
		expect(config.ollama?.model).toBe('gemma2:2b');
	});

	it('sets claude.fastModel when CLAUDE_FAST_MODEL is provided', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, {
			...requiredEnvVars,
			CLAUDE_FAST_MODEL: 'claude-haiku-4-5-20251001',
		});

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.claude.fastModel).toBe('claude-haiku-4-5-20251001');
	});

	// --- Multi-provider LLM config tests ---

	it('builds llm config with built-in providers', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, requiredEnvVars);

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.llm).toBeDefined();
		expect(config.llm?.providers.anthropic).toBeDefined();
		expect(config.llm?.providers.anthropic.type).toBe('anthropic');
		expect(config.llm?.providers.google).toBeDefined();
		expect(config.llm?.providers.ollama).toBeDefined();
	});

	it('auto-assigns standard tier to anthropic when only ANTHROPIC_API_KEY is set', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, requiredEnvVars);

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.llm?.tiers.standard.provider).toBe('anthropic');
	});

	it('auto-assigns fast tier to anthropic haiku when only ANTHROPIC_API_KEY is set', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, requiredEnvVars);

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.llm?.tiers.fast.provider).toBe('anthropic');
		expect(config.llm?.tiers.fast.model).toContain('haiku');
	});

	it('prefers google for fast tier when GOOGLE_AI_API_KEY is set', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, {
			...requiredEnvVars,
			GOOGLE_AI_API_KEY: 'AIza-test-key',
		});

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.llm?.tiers.fast.provider).toBe('google');
		expect(config.llm?.tiers.fast.model).toContain('gemini');
	});

	it('merges custom providers from pas.yaml', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				llm: {
					providers: {
						groq: {
							type: 'openai-compatible',
							name: 'Groq',
							api_key_env: 'GROQ_API_KEY',
							base_url: 'https://api.groq.com/openai/v1',
							default_model: 'llama-3.3-70b',
						},
					},
				},
			}),
			'utf-8',
		);

		const config = await loadSystemConfig({
			envPath,
			configPath: yamlPath,
		});

		expect(config.llm?.providers.groq).toBeDefined();
		expect(config.llm?.providers.groq.type).toBe('openai-compatible');
		expect(config.llm?.providers.groq.baseUrl).toBe('https://api.groq.com/openai/v1');
		// Built-in providers should still be present
		expect(config.llm?.providers.anthropic).toBeDefined();
	});

	it('uses explicit tier assignments from pas.yaml', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		// Groq needs credentials — define it as a custom provider with its own API key
		await writeEnvFile(envPath, { ...requiredEnvVars, GROQ_API_KEY: 'test-groq-key' });
		await writeFile(
			yamlPath,
			stringify({
				llm: {
					providers: {
						groq: {
							type: 'openai-compatible',
							name: 'Groq',
							api_key_env: 'GROQ_API_KEY',
							base_url: 'https://api.groq.com/openai/v1',
							default_model: 'llama-3.3-70b',
						},
					},
					tiers: {
						fast: { provider: 'groq', model: 'llama-3.3-70b' },
						standard: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
					},
				},
			}),
			'utf-8',
		);

		const config = await loadSystemConfig({
			envPath,
			configPath: yamlPath,
		});

		expect(config.llm?.tiers.fast).toEqual({ provider: 'groq', model: 'llama-3.3-70b' });
		expect(config.llm?.tiers.standard).toEqual({
			provider: 'anthropic',
			model: 'claude-sonnet-4-20250514',
		});
	});

	it('throws when explicit tier provider has no credentials', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		// groq is pinned in tiers but no GROQ_API_KEY set and no custom provider definition
		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				llm: {
					tiers: {
						fast: { provider: 'groq', model: 'llama-3.3-70b' },
						standard: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
					},
				},
			}),
			'utf-8',
		);

		await expect(loadSystemConfig({ envPath, configPath: yamlPath })).rejects.toThrow(
			/LLM tier 'fast' is pinned to provider 'groq'.*no valid credentials/,
		);
	});

	it('parses safeguards config from pas.yaml', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				llm: {
					safeguards: {
						default_rate_limit: { max_requests: 100, window_seconds: 3600 },
						default_monthly_cost_cap: 5.0,
						global_monthly_cost_cap: 25.0,
					},
				},
			}),
			'utf-8',
		);

		const config = await loadSystemConfig({
			envPath,
			configPath: yamlPath,
		});

		expect(config.llm?.safeguards).toBeDefined();
		expect(config.llm?.safeguards?.defaultRateLimit.maxRequests).toBe(100);
		expect(config.llm?.safeguards?.defaultMonthlyCostCap).toBe(5.0);
		expect(config.llm?.safeguards?.globalMonthlyCostCap).toBe(25.0);
	});

	it('throws on malformed pas.yaml (fail fast)', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(yamlPath, '{{{{invalid yaml: [[[', 'utf-8');

		// D14 fix: malformed YAML now fails fast at startup instead of silently using defaults
		await expect(loadSystemConfig({ envPath, configPath: yamlPath })).rejects.toThrow(
			'Failed to parse pas.yaml',
		);
	});

	// --- Fallback config tests ---

	it('parses fallback: chatbot from pas.yaml defaults', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(yamlPath, stringify({ defaults: { fallback: 'chatbot' } }), 'utf-8');

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });

		expect(config.fallback).toBe('chatbot');
	});

	it('parses fallback: notes from pas.yaml defaults', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(yamlPath, stringify({ defaults: { fallback: 'notes' } }), 'utf-8');

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });

		expect(config.fallback).toBe('notes');
	});

	it('defaults fallback to chatbot when not specified', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, requiredEnvVars);

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.fallback).toBe('chatbot');
	});

	it('defaults fallback to chatbot for invalid values', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(yamlPath, stringify({ defaults: { fallback: 'invalid' } }), 'utf-8');

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });

		expect(config.fallback).toBe('chatbot');
	});

	it('applies CLAUDE_MODEL env override to anthropic provider defaultModel', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, {
			...requiredEnvVars,
			CLAUDE_MODEL: 'claude-opus-4-6',
		});

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.llm?.providers.anthropic.defaultModel).toBe('claude-opus-4-6');
	});

	// --- Route verification config tests ---

	it('enables route verification by default when section is absent', async () => {
		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, requiredEnvVars);

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.routing?.verification?.enabled).toBe(true);
		expect(config.routing?.verification?.upperBound).toBe(0.7);
	});

	it('enables route verification by default when routing section exists but enabled is omitted', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({ routing: { verification: { upper_bound: 0.8 } } }),
			'utf-8',
		);

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });

		expect(config.routing?.verification?.enabled).toBe(true);
		expect(config.routing?.verification?.upperBound).toBe(0.8);
	});

	it('respects explicit enabled: false for route verification', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({ routing: { verification: { enabled: false } } }),
			'utf-8',
		);

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });

		expect(config.routing?.verification?.enabled).toBe(false);
	});

	it('clamps upper_bound to [0, 1] range', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({ routing: { verification: { upper_bound: 1.5 } } }),
			'utf-8',
		);

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });

		expect(config.routing?.verification?.upperBound).toBe(1);
	});

	it('clamps negative upper_bound to 0', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');

		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({ routing: { verification: { upper_bound: -0.5 } } }),
			'utf-8',
		);

		const config = await loadSystemConfig({ envPath, configPath: yamlPath });

		expect(config.routing?.verification?.upperBound).toBe(0);
	});

	// --- F11: Optional Anthropic / multi-provider startup tests ---

	it('starts with only GOOGLE_AI_API_KEY and no ANTHROPIC_API_KEY', async () => {
		// Stub env to ensure only Google key is present — prevents leakage from prior tests
		vi.stubEnv('ANTHROPIC_API_KEY', '');
		vi.stubEnv('GOOGLE_AI_API_KEY', 'test-google-key');
		vi.stubEnv('OPENAI_API_KEY', '');
		vi.stubEnv('OLLAMA_URL', '');

		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, {
			TELEGRAM_BOT_TOKEN: 'test-bot-token',
			GUI_AUTH_TOKEN: 'test-gui-token',
			GOOGLE_AI_API_KEY: 'test-google-key',
		});

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		// Tiers should auto-assign to google (not anthropic)
		expect(config.llm?.tiers.standard.provider).toBe('google');
		expect(config.llm?.tiers.fast.provider).toBe('google');
		expect(config.claude?.apiKey).toBe('');

		vi.unstubAllEnvs();
	});

	it('starts with only OPENAI_API_KEY and no ANTHROPIC_API_KEY', async () => {
		vi.stubEnv('ANTHROPIC_API_KEY', '');
		vi.stubEnv('GOOGLE_AI_API_KEY', '');
		vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
		vi.stubEnv('OLLAMA_URL', '');

		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, {
			TELEGRAM_BOT_TOKEN: 'test-bot-token',
			GUI_AUTH_TOKEN: 'test-gui-token',
			OPENAI_API_KEY: 'test-openai-key',
		});

		const config = await loadSystemConfig({
			envPath,
			configPath: join(tempDir, 'nonexistent.yaml'),
		});

		expect(config.llm?.tiers.standard.provider).toBe('openai');
		expect(config.llm?.tiers.fast.provider).toBe('openai');

		vi.unstubAllEnvs();
	});

	it('throws when no LLM provider keys are set', async () => {
		vi.stubEnv('ANTHROPIC_API_KEY', '');
		vi.stubEnv('GOOGLE_AI_API_KEY', '');
		vi.stubEnv('OPENAI_API_KEY', '');
		vi.stubEnv('OLLAMA_URL', '');

		const envPath = join(tempDir, '.env');
		await writeEnvFile(envPath, {
			TELEGRAM_BOT_TOKEN: 'test-bot-token',
			GUI_AUTH_TOKEN: 'test-gui-token',
		});

		await expect(
			loadSystemConfig({ envPath, configPath: join(tempDir, 'nonexistent.yaml') }),
		).rejects.toThrow(/No LLM providers available/);

		vi.unstubAllEnvs();
	});

	it('throws when only tiers.fast is specified without tiers.standard (F11)', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');
		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				llm: {
					tiers: {
						fast: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
						// standard intentionally omitted
					},
				},
			}),
			'utf-8',
		);

		await expect(loadSystemConfig({ envPath, configPath: yamlPath })).rejects.toThrow(
			/tiers.fast.*without.*tiers.standard|either specify both/i,
		);
	});

	it('throws when only tiers.standard is specified without tiers.fast (F11)', async () => {
		const envPath = join(tempDir, '.env');
		const yamlPath = join(tempDir, 'pas.yaml');
		await writeEnvFile(envPath, requiredEnvVars);
		await writeFile(
			yamlPath,
			stringify({
				llm: {
					tiers: {
						standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
						// fast intentionally omitted
					},
				},
			}),
			'utf-8',
		);

		await expect(loadSystemConfig({ envPath, configPath: yamlPath })).rejects.toThrow(
			/tiers.standard.*without.*tiers.fast|either specify both/i,
		);
	});
});
