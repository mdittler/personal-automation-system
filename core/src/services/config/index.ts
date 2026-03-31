/**
 * System configuration loader.
 *
 * Loads configuration from two sources:
 * 1. .env file → environment variables (secrets, infrastructure settings)
 * 2. config/pas.yaml → user config (registered users, shared scopes, LLM providers)
 *
 * Validates required env vars via envalid and merges everything
 * into a typed SystemConfig object.
 */

import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { cleanEnv, port, str } from 'envalid';
import type {
	LLMConfig,
	LLMProviderConfig,
	SystemConfig,
	TierAssignment,
} from '../../types/config.js';
import type { ModelRef } from '../../types/llm.js';
import type { RegisteredUser } from '../../types/users.js';
import type { WebhookDefinition } from '../../types/webhooks.js';
import { readYamlFile } from '../../utils/yaml.js';
import { DEFAULT_PROVIDERS } from './default-providers.js';

/** Shape of an LLM provider entry in pas.yaml. */
interface YamlProviderConfig {
	type: string;
	name: string;
	api_key_env: string;
	base_url?: string;
	default_model?: string;
}

/** Shape of the llm section in pas.yaml. */
interface YamlLLMConfig {
	providers?: Record<string, YamlProviderConfig>;
	tiers?: {
		fast?: { provider: string; model: string };
		standard?: { provider: string; model: string };
		reasoning?: { provider: string; model: string };
	};
	safeguards?: {
		default_rate_limit?: { max_requests: number; window_seconds: number };
		default_monthly_cost_cap?: number;
		global_monthly_cost_cap?: number;
	};
}

/** Shape of a webhook entry in pas.yaml. */
interface YamlWebhookConfig {
	id: string;
	url: string;
	events: string[];
	secret?: string;
}

/** Shape of the parsed config/pas.yaml file. */
interface PasYamlConfig {
	users?: Array<{
		id: string;
		name: string;
		is_admin?: boolean;
		enabled_apps?: string[];
		shared_scopes?: string[];
	}>;
	defaults?: {
		log_level?: string;
		timezone?: string;
		fallback?: string;
	};
	llm?: YamlLLMConfig;
	webhooks?: YamlWebhookConfig[];
	n8n?: {
		dispatch_url?: string;
	};
}

/**
 * Load and validate system configuration.
 *
 * @param options.envPath - Path to .env file. Defaults to project root .env.
 * @param options.configPath - Path to pas.yaml. Defaults to config/pas.yaml.
 * @returns Validated SystemConfig
 */
export async function loadSystemConfig(options?: {
	envPath?: string;
	configPath?: string;
}): Promise<SystemConfig> {
	// Load .env file
	loadDotenv({ path: options?.envPath });

	// Validate required env vars
	const env = cleanEnv(process.env, {
		TELEGRAM_BOT_TOKEN: str({ desc: 'Telegram Bot API token from @BotFather' }),
		ANTHROPIC_API_KEY: str({ desc: 'Anthropic Claude API key' }),
		GUI_AUTH_TOKEN: str({ desc: 'Management GUI authentication token' }),
		OLLAMA_URL: str({
			default: '',
			desc: 'Ollama server URL (empty = use Claude for all LLM tasks)',
		}),
		OLLAMA_MODEL: str({ default: 'llama3.2:3b', desc: 'Default Ollama model' }),
		CLAUDE_MODEL: str({ default: 'claude-sonnet-4-20250514', desc: 'Default Claude model' }),
		CLAUDE_FAST_MODEL: str({
			default: '',
			desc: 'Fast Claude model for classification (e.g. claude-haiku-4-5-20251001)',
		}),
		GOOGLE_AI_API_KEY: str({ default: '', desc: 'Google AI API key (optional)' }),
		OPENAI_API_KEY: str({ default: '', desc: 'OpenAI API key (optional)' }),
		PORT: port({ default: 3000, desc: 'Fastify server port' }),
		DATA_DIR: str({ default: './data', desc: 'Path to data directory' }),
		LOG_LEVEL: str({
			default: 'info',
			choices: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
			desc: 'Log level',
		}),
		CLOUDFLARE_TUNNEL_TOKEN: str({ default: '', desc: 'Cloudflare Tunnel token' }),
		API_TOKEN: str({
			default: '',
			desc: 'Bearer token for external data API (empty = API disabled)',
		}),
	});

	// Load pas.yaml
	const configPath = options?.configPath ?? resolve('config', 'pas.yaml');
	const yamlConfig = await readYamlFile<PasYamlConfig>(configPath);

	// Parse registered users from YAML
	const users: RegisteredUser[] = (yamlConfig?.users ?? []).map((u) => ({
		id: u.id,
		name: u.name,
		isAdmin: u.is_admin ?? false,
		enabledApps: u.enabled_apps ?? [],
		sharedScopes: u.shared_scopes ?? [],
	}));

	// Build multi-provider LLM config (use process.env directly for provider key lookups)
	const llmConfig = buildLLMConfig(process.env as Record<string, string>, yamlConfig?.llm);

	// Parse webhooks from YAML
	const webhooks: WebhookDefinition[] = (yamlConfig?.webhooks ?? []).map((wh) => ({
		id: wh.id,
		url: wh.url,
		events: wh.events ?? [],
		secret: wh.secret,
	}));

	// Merge into SystemConfig
	const config: SystemConfig = {
		port: env.PORT,
		dataDir: resolve(env.DATA_DIR),
		logLevel: yamlConfig?.defaults?.log_level ?? env.LOG_LEVEL,
		timezone: yamlConfig?.defaults?.timezone ?? 'UTC',
		fallback: yamlConfig?.defaults?.fallback === 'notes' ? 'notes' : 'chatbot',
		telegram: {
			botToken: env.TELEGRAM_BOT_TOKEN,
		},
		ollama: env.OLLAMA_URL ? { url: env.OLLAMA_URL, model: env.OLLAMA_MODEL } : undefined,
		claude: {
			apiKey: env.ANTHROPIC_API_KEY,
			model: env.CLAUDE_MODEL,
			fastModel: env.CLAUDE_FAST_MODEL || undefined,
		},
		llm: llmConfig,
		gui: {
			authToken: env.GUI_AUTH_TOKEN,
		},
		api: {
			token: env.API_TOKEN || '',
		},
		cloudflare: {
			tunnelToken: env.CLOUDFLARE_TUNNEL_TOKEN || undefined,
		},
		webhooks,
		n8n: {
			dispatchUrl: yamlConfig?.n8n?.dispatch_url ?? '',
		},
		users,
	};

	return config;
}

/**
 * Build the multi-provider LLM configuration.
 *
 * Merges built-in default providers with custom providers from pas.yaml.
 * Applies env var overrides for built-in provider settings.
 * Auto-assigns tiers if not explicitly configured.
 */
function buildLLMConfig(env: Record<string, string>, yamlLLM?: YamlLLMConfig): LLMConfig {
	// Start with built-in defaults (deep copy to avoid mutating the constant)
	const providers: Record<string, LLMProviderConfig> = {};
	for (const [id, def] of Object.entries(DEFAULT_PROVIDERS)) {
		providers[id] = { ...def };
	}

	// Apply env var overrides for built-in providers
	if (env.CLAUDE_MODEL && providers.anthropic) {
		providers.anthropic.defaultModel = env.CLAUDE_MODEL;
	}
	if (env.OLLAMA_URL && providers.ollama) {
		providers.ollama.baseUrl = env.OLLAMA_URL;
	}
	if (env.OLLAMA_MODEL && providers.ollama) {
		providers.ollama.defaultModel = env.OLLAMA_MODEL;
	}

	// Merge custom providers from pas.yaml (custom providers override built-in)
	if (yamlLLM?.providers) {
		for (const [id, yamlProvider] of Object.entries(yamlLLM.providers)) {
			providers[id] = {
				type: yamlProvider.type as LLMProviderConfig['type'],
				name: yamlProvider.name,
				apiKeyEnvVar: yamlProvider.api_key_env,
				baseUrl: yamlProvider.base_url,
				defaultModel: yamlProvider.default_model,
			};
		}
	}

	// Parse explicit tier assignments from YAML
	let tiers: TierAssignment | undefined;
	if (yamlLLM?.tiers) {
		const fast = yamlLLM.tiers.fast;
		const standard = yamlLLM.tiers.standard;
		if (fast && standard) {
			tiers = {
				fast: { provider: fast.provider, model: fast.model },
				standard: { provider: standard.provider, model: standard.model },
			};
			if (yamlLLM.tiers.reasoning) {
				tiers.reasoning = {
					provider: yamlLLM.tiers.reasoning.provider,
					model: yamlLLM.tiers.reasoning.model,
				};
			}
		}
	}

	// Auto-assign tiers if not explicitly configured
	if (!tiers) {
		tiers = autoAssignTiers(providers, env);
	}

	// Parse safeguards
	const safeguards = yamlLLM?.safeguards
		? {
				defaultRateLimit: {
					maxRequests: yamlLLM.safeguards.default_rate_limit?.max_requests ?? 60,
					windowSeconds: yamlLLM.safeguards.default_rate_limit?.window_seconds ?? 3600,
				},
				defaultMonthlyCostCap: yamlLLM.safeguards.default_monthly_cost_cap ?? 10.0,
				globalMonthlyCostCap: yamlLLM.safeguards.global_monthly_cost_cap ?? 50.0,
			}
		: undefined;

	return { providers, tiers, safeguards };
}

/**
 * Auto-assign tiers based on available providers.
 *
 * Priority for standard: anthropic > openai > google > ollama
 * Priority for fast: google > openai > anthropic (fast model) > ollama
 * Priority for reasoning: anthropic (opus) > openai (o3)
 */
function autoAssignTiers(
	providers: Record<string, LLMProviderConfig>,
	env: Record<string, string>,
): TierAssignment {
	const available = getAvailableProviderIds(providers, env);

	const standardRef = pickFirstAvailable(available, providers, [
		'anthropic',
		'openai',
		'google',
		'ollama',
	]);

	// For fast tier, prefer cheap/fast models
	const fastRef = pickFastTier(available, providers, env);

	return {
		fast: fastRef ?? standardRef ?? { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
		standard: standardRef ?? { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
	};
}

/**
 * Get provider IDs that have valid credentials / configuration.
 */
function getAvailableProviderIds(
	providers: Record<string, LLMProviderConfig>,
	env: Record<string, string>,
): Set<string> {
	const available = new Set<string>();
	for (const [id, config] of Object.entries(providers)) {
		if (config.type === 'ollama') {
			// Ollama needs a base URL
			if (config.baseUrl) available.add(id);
		} else {
			// Other providers need an API key
			const key = config.apiKeyEnvVar ? env[config.apiKeyEnvVar] : '';
			if (key) available.add(id);
		}
	}
	return available;
}

/**
 * Pick the first available provider from the preference list.
 */
function pickFirstAvailable(
	available: Set<string>,
	providers: Record<string, LLMProviderConfig>,
	preference: string[],
): ModelRef | undefined {
	for (const id of preference) {
		if (available.has(id) && providers[id]) {
			return { provider: id, model: providers[id].defaultModel ?? '' };
		}
	}
	return undefined;
}

/**
 * Pick the best model for the fast tier.
 * Prefers cheap/fast models: Google Flash > OpenAI mini > Anthropic Haiku > Ollama.
 */
function pickFastTier(
	available: Set<string>,
	providers: Record<string, LLMProviderConfig>,
	env: Record<string, string>,
): ModelRef | undefined {
	// Google Gemini Flash is very fast and cheap
	if (available.has('google')) {
		return { provider: 'google', model: 'gemini-2.0-flash' };
	}
	// OpenAI mini models are fast and cheap
	if (available.has('openai')) {
		return { provider: 'openai', model: 'gpt-4.1-mini' };
	}
	// Anthropic: use fast model if configured, otherwise Haiku
	if (available.has('anthropic')) {
		const fastModel = env.CLAUDE_FAST_MODEL || 'claude-haiku-4-5-20251001';
		return { provider: 'anthropic', model: fastModel };
	}
	// Ollama
	if (available.has('ollama') && providers.ollama) {
		return { provider: 'ollama', model: providers.ollama.defaultModel ?? 'llama3.2:3b' };
	}
	return undefined;
}
