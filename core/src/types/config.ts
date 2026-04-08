/**
 * Configuration types.
 *
 * SystemConfig is the top-level configuration loaded from
 * config/pas.yaml + .env. AppConfigService is the per-user
 * config interface provided to apps.
 */

import type { ModelRef, ModelTier, ProviderType } from './llm.js';
import type { RegisteredUser } from './users.js';
import type { WebhookDefinition } from './webhooks.js';

// ---------------------------------------------------------------------------
// Multi-provider LLM configuration
// ---------------------------------------------------------------------------

/** Configuration for a single LLM provider. */
export interface LLMProviderConfig {
	/** Provider type determines which client class to use. */
	type: ProviderType;
	/** Display name for the GUI. */
	name: string;
	/** Environment variable name that holds the API key. */
	apiKeyEnvVar: string;
	/** API base URL (required for openai-compatible, optional for others). */
	baseUrl?: string;
	/** Default model ID for this provider. */
	defaultModel?: string;
}

/** Tier-to-model assignment: which provider+model to use for each tier. */
export type TierAssignment = {
	fast: ModelRef;
	standard: ModelRef;
	reasoning?: ModelRef;
} & Partial<Record<ModelTier, ModelRef>>;

/** Safeguard defaults for LLM usage. */
export interface LLMSafeguardsConfig {
	/** Default per-app rate limit. */
	defaultRateLimit: {
		maxRequests: number;
		windowSeconds: number;
	};
	/** Default per-app monthly cost cap in USD. */
	defaultMonthlyCostCap: number;
	/** Global monthly cost cap in USD (kill switch). */
	globalMonthlyCostCap: number;
}

/** Top-level LLM configuration (multi-provider). */
export interface LLMConfig {
	/** Configured providers, keyed by provider ID. */
	providers: Record<string, LLMProviderConfig>;
	/** Tier-to-model assignments. */
	tiers: TierAssignment;
	/** Safeguard defaults. */
	safeguards?: LLMSafeguardsConfig;
}

// ---------------------------------------------------------------------------
// System configuration
// ---------------------------------------------------------------------------

/** Top-level system configuration. */
export interface SystemConfig {
	/** Fastify server port. Default: 3000. */
	port: number;
	/** Path to the data directory. Default: ./data. */
	dataDir: string;
	/** Log level: trace, debug, info, warn, error, fatal. */
	logLevel: string;
	/** Timezone for scheduled jobs and timestamps. */
	timezone: string;

	/** Telegram bot configuration. */
	telegram: {
		/** Bot API token from @BotFather. */
		botToken: string;
	};

	/**
	 * Ollama (local LLM) configuration. Undefined when Ollama is not available.
	 * @deprecated Subsumed by `llm.providers.ollama`. Kept for backward compat.
	 */
	ollama?: {
		/** Ollama server URL. */
		url: string;
		/** Default model for classification and parsing. */
		model: string;
	};

	/**
	 * Claude API (remote LLM) configuration.
	 * @deprecated Subsumed by `llm.providers.anthropic`. Kept for backward compat.
	 */
	claude: {
		/** Anthropic API key. */
		apiKey: string;
		/** Default Claude model for complex reasoning. */
		model: string;
		/** Fast Claude model for classification/extraction (used when Ollama is unavailable). */
		fastModel?: string;
	};

	/** Multi-provider LLM configuration. */
	llm?: LLMConfig;

	/** Management GUI configuration. */
	gui: {
		/** Bearer token for GUI authentication. */
		authToken: string;
	};

	/** External data API configuration. */
	api: {
		/** Bearer token for API authentication (empty = API disabled). */
		token: string;
	};

	/** Cloudflare Tunnel configuration. */
	cloudflare: {
		/** Tunnel token (optional, tunnel may be managed externally). */
		tunnelToken?: string;
	};

	/** Fallback mode: 'chatbot' uses AI chatbot, 'notes' appends to daily notes. Default: 'chatbot'. */
	fallback: 'chatbot' | 'notes';

	/** Outbound webhooks for event delivery to external services. */
	webhooks: WebhookDefinition[];

	/** n8n integration configuration. */
	n8n: {
		/** Webhook URL for dispatching execution to n8n. Empty = internal execution (default). */
		dispatchUrl: string;
	};

	/** Routing configuration (optional — verification disabled by default). */
	routing?: {
		verification?: RoutingVerificationConfig;
	};

	/** Registered users. */
	users: RegisteredUser[];
}

/** Route verification configuration. */
export interface RoutingVerificationConfig {
	/** Whether route verification is enabled. */
	enabled: boolean;
	/** Confidence upper bound — above this, skip verification. */
	upperBound: number;
}

/** App configuration service provided to apps via CoreServices. */
export interface AppConfigService {
	/**
	 * Get a config value for the current user.
	 * Returns the default from the manifest if not overridden.
	 */
	get<T>(key: string): Promise<T>;

	/**
	 * Get all config values.
	 * When userId is provided, reads that user's overrides.
	 * When omitted, uses the current user context (set by infrastructure).
	 */
	getAll(userId?: string): Promise<Record<string, unknown>>;
}
