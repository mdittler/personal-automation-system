/**
 * App manifest types.
 *
 * These types mirror the manifest.yaml structure defined in PAS-APP-SPEC-001.
 * The manifest is the contract between an app and the infrastructure.
 */

/** The top-level manifest structure. */
export interface AppManifest {
	app: ManifestIdentity;
	capabilities?: ManifestCapabilities;
	requirements?: ManifestRequirements;
	user_config?: ManifestUserConfig[];
}

/** App identity block — all fields required. */
export interface ManifestIdentity {
	/** Unique string ID. Lowercase, hyphens ok. Used as namespace. */
	id: string;
	/** Human-readable name. Shown in management GUI. */
	name: string;
	/** Semver version string. */
	version: string;
	/** 1-3 sentence description shown in management GUI. */
	description: string;
	/** Author name. */
	author: string;
	/** Optional repository URL. */
	repository?: string;
	/** Required CoreServices API version range (semver). E.g. ">=1.0.0 <2.0.0". */
	pas_core_version?: string;
	/** SPDX license identifier. E.g. "MIT", "Apache-2.0". */
	license?: string;
	/** Discovery keywords for app search and categorization. */
	tags?: string[];
	/** App category for organization and discovery. */
	category?: 'productivity' | 'home' | 'health' | 'finance' | 'social' | 'utility';
	/** Project homepage URL. */
	homepage?: string;
}

/** What the app can do — messages, schedules, rules, events. */
export interface ManifestCapabilities {
	messages?: ManifestMessages;
	schedules?: ManifestSchedule[];
	rules?: ManifestRules;
	events?: ManifestEvents;
}

/** Message-handling capabilities. */
export interface ManifestMessages {
	/** Keywords/phrases the router uses for intent classification. */
	intents?: string[];
	/** Explicit /commands this app handles. */
	commands?: ManifestCommand[];
	/** Whether this app processes photo messages. */
	accepts_photos?: boolean;
	/** Photo classification types this app handles. */
	photo_intents?: string[];
}

/** A /command definition. */
export interface ManifestCommand {
	/** Command name including the leading slash. */
	name: string;
	/** Human-readable description shown in /help. */
	description: string;
	/** Named positional arguments. */
	args?: string[];
}

/** A scheduled job definition. */
export interface ManifestSchedule {
	/** Unique job ID within this app. */
	id: string;
	/** Human-readable description. */
	description: string;
	/** Standard 5-field cron expression. */
	cron: string;
	/** Handler file path relative to app root. */
	handler: string;
	/** Scope: 'all' = per user, 'shared' = once for shared data, 'system' = once, no user. */
	user_scope: 'all' | 'shared' | 'system';
}

/** Condition evaluator rule file declarations. */
export interface ManifestRules {
	/** Paths to rule files relative to app root. */
	files?: string[];
}

/** Event declarations. */
export interface ManifestEvents {
	/** Events this app emits. */
	emits?: ManifestEventEmit[];
	/** Events this app subscribes to. */
	subscribes?: ManifestEventSubscribe[];
}

/** An event this app emits. */
export interface ManifestEventEmit {
	/** Event ID, namespaced with app ID (e.g. "grocery.list.updated"). */
	id: string;
	/** Human-readable description. */
	description: string;
	/** JSON Schema for the event payload. */
	payload?: object;
}

/** An event this app subscribes to. */
export interface ManifestEventSubscribe {
	/** Event ID from another app. */
	event: string;
	/** Handler file path relative to app root. */
	handler: string;
	/** If false, app works without this event. Defaults to false. */
	required?: boolean;
}

/** LLM usage configuration declared by an app. */
export interface ManifestLLMRequirements {
	/** Preferred model tier. Informational — does not restrict access to other tiers. */
	tier?: 'fast' | 'standard' | 'reasoning';
	/** Custom rate limit (overrides system default). */
	rate_limit?: {
		max_requests: number;
		window_seconds: number;
	};
	/** Custom monthly cost cap in USD (overrides system default). */
	monthly_cost_cap?: number;
}

/** What the app needs from the infrastructure. */
export interface ManifestRequirements {
	/** Infrastructure services used (e.g. 'telegram', 'llm', 'data-store'). */
	services?: string[];
	/** External APIs this app calls. */
	external_apis?: ManifestExternalApi[];
	/** Data access scopes. */
	data?: ManifestDataRequirements;
	/** Soft dependencies on other apps. */
	integrations?: ManifestIntegration[];
	/** LLM usage configuration (per-app overrides for safeguards). */
	llm?: ManifestLLMRequirements;
}

/** An external API dependency. */
export interface ManifestExternalApi {
	/** Unique API ID within this app. */
	id: string;
	/** Why this API is needed. */
	description: string;
	/** If true, app won't load without the env var set. */
	required: boolean;
	/** Environment variable name for the credential. */
	env_var: string;
	/** What happens when this optional API is unavailable. */
	fallback_behavior?: string;
}

/** Data access scope declarations. */
export interface ManifestDataRequirements {
	/** Per-user private data paths. */
	user_scopes?: ManifestDataScope[];
	/** Shared data paths. */
	shared_scopes?: ManifestDataScope[];
	/** Context store keys this app reads. */
	context_reads?: string[];
}

/** A single data scope declaration. */
export interface ManifestDataScope {
	/** File or directory path relative to the app's data directory. */
	path: string;
	/** Access level. */
	access: 'read' | 'write' | 'read-write';
	/** Human-readable description of what this data is. */
	description: string;
}

/** A soft dependency on another app. */
export interface ManifestIntegration {
	/** ID of the other app. */
	app: string;
	/** Why this integration exists. */
	description: string;
	/** Must always be false — apps must work standalone. */
	required: boolean;
}

/** A user-configurable setting surfaced in the management GUI. */
export interface ManifestUserConfig {
	/** Config key. */
	key: string;
	/** Value type. */
	type: 'string' | 'number' | 'boolean' | 'select';
	/** Default value. */
	default: unknown;
	/** Human-readable description. */
	description: string;
	/** Options for type: 'select'. */
	options?: string[];
}
