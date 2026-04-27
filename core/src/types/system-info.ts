/**
 * System introspection service types.
 *
 * Provides read-only access to system state (models, costs, scheduling,
 * status) plus model switching. Designed for the chatbot /ask command
 * to answer admin-level system questions.
 */

/** Active model assignment for a tier. */
export interface TierInfo {
	tier: string;
	provider: string;
	model: string;
}

/** Summary of a configured LLM provider. */
export interface ProviderInfo {
	id: string;
	type: string;
}

/** Monthly cost breakdown. */
export interface CostSummary {
	month: string;
	monthlyTotal: number;
	perApp: Record<string, number>;
	perUser: Record<string, number>;
}

/** Pricing info for a specific model. */
export interface ModelPricingInfo {
	modelId: string;
	inputPerMillion: number;
	outputPerMillion: number;
}

/** Info about a registered cron job. */
export interface ScheduledJobInfo {
	key: string;
	appId: string;
	cron: string;
	description?: string;
}

/** High-level system status. */
export interface SystemStatusInfo {
	uptimeSeconds: number;
	appCount: number;
	userCount: number;
	cronJobCount: number;
	timezone: string;
}

/** Safeguard configuration defaults. */
export interface SafeguardInfo {
	rateLimit: { maxRequests: number; windowSeconds: number };
	appMonthlyCostCap: number;
	globalMonthlyCostCap: number;
}

/** Available model from any provider. */
export interface AvailableModelInfo {
	id: string;
	provider: string;
	displayName?: string;
}

/**
 * Read-only system introspection service (plus model switching).
 *
 * Apps declare "system-info" in manifest requirements.services to receive this.
 */
export interface SystemInfoService {
	/** Get active model assignment for each tier. */
	getTierAssignments(): TierInfo[];

	/** Get configured LLM providers. */
	getProviders(): ProviderInfo[];

	/** Get available models across all providers. */
	getAvailableModels(): Promise<AvailableModelInfo[]>;

	/** Get pricing for a specific model (null if unknown). */
	getModelPricing(modelId: string): ModelPricingInfo | null;

	/** Get monthly cost summary (total + per-app). */
	getCostSummary(): CostSummary;

	/** Get all registered cron jobs. */
	getScheduledJobs(): ScheduledJobInfo[];

	/** Get high-level system status. */
	getSystemStatus(): SystemStatusInfo;

	/** Get LLM safeguard defaults. */
	getSafeguardDefaults(): SafeguardInfo;

	/** Switch the active model for a tier (only write operation). */
	setTierModel(
		tier: string,
		provider: string,
		model: string,
	): Promise<{ success: boolean; error?: string }>;

	/** Check whether a registered user has admin privileges. Returns false for unknown users. */
	isUserAdmin(userId: string): boolean;
}
