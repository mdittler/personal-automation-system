/**
 * System introspection service.
 *
 * Aggregates read-only data from infrastructure services (models, costs,
 * scheduling, status) for the chatbot /ask command. The only write
 * operation is model tier switching.
 */

import type { Logger } from 'pino';
import type { LLMSafeguardsConfig } from '../../types/config.js';
import type {
	AvailableModelInfo,
	CostSummary,
	ModelPricingInfo,
	ProviderInfo,
	SafeguardInfo,
	ScheduledJobInfo,
	SystemInfoService,
	SystemStatusInfo,
	TierInfo,
} from '../../types/system-info.js';
import type { AppRegistry } from '../app-registry/index.js';
import type { CostTracker } from '../llm/cost-tracker.js';
import type { ModelCatalog } from '../llm/model-catalog.js';
import { getModelPricing } from '../llm/model-pricing.js';
import type { ModelSelector } from '../llm/model-selector.js';
import type { ProviderRegistry } from '../llm/providers/provider-registry.js';
import type { CronManager } from '../scheduler/cron-manager.js';
import type { UserManager } from '../user-manager/index.js';

/** Model ID validation pattern (same as GUI). */
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,100}$/;

/** Valid tier names. */
const VALID_TIERS = new Set(['fast', 'standard', 'reasoning']);

export interface SystemInfoServiceOptions {
	modelSelector: ModelSelector;
	providerRegistry: ProviderRegistry;
	modelCatalog: ModelCatalog;
	costTracker: CostTracker;
	cronManager: CronManager;
	userManager: UserManager;
	appRegistry: AppRegistry;
	safeguards: LLMSafeguardsConfig;
	timezone: string;
	fallbackMode: string;
	logger: Logger;
}

export class SystemInfoServiceImpl implements SystemInfoService {
	private readonly modelSelector: ModelSelector;
	private readonly providerRegistry: ProviderRegistry;
	private readonly modelCatalog: ModelCatalog;
	private readonly costTracker: CostTracker;
	private readonly cronManager: CronManager;
	private readonly userManager: UserManager;
	private readonly appRegistry: AppRegistry;
	private readonly safeguards: LLMSafeguardsConfig;
	private readonly timezone: string;
	private readonly fallbackMode: string;
	private readonly logger: Logger;

	constructor(options: SystemInfoServiceOptions) {
		this.modelSelector = options.modelSelector;
		this.providerRegistry = options.providerRegistry;
		this.modelCatalog = options.modelCatalog;
		this.costTracker = options.costTracker;
		this.cronManager = options.cronManager;
		this.userManager = options.userManager;
		this.appRegistry = options.appRegistry;
		this.safeguards = options.safeguards;
		this.timezone = options.timezone;
		this.fallbackMode = options.fallbackMode;
		this.logger = options.logger;
	}

	getTierAssignments(): TierInfo[] {
		const tiers: TierInfo[] = [];
		const standard = this.modelSelector.getStandardRef();
		tiers.push({ tier: 'standard', provider: standard.provider, model: standard.model });

		const fast = this.modelSelector.getFastRef();
		tiers.push({ tier: 'fast', provider: fast.provider, model: fast.model });

		const reasoning = this.modelSelector.getReasoningRef();
		if (reasoning) {
			tiers.push({ tier: 'reasoning', provider: reasoning.provider, model: reasoning.model });
		}

		return tiers;
	}

	getProviders(): ProviderInfo[] {
		return this.providerRegistry.getAll().map((p) => ({
			id: p.providerId,
			type: p.providerType,
		}));
	}

	async getAvailableModels(): Promise<AvailableModelInfo[]> {
		try {
			const models = await this.modelCatalog.getModels();
			return models.map((m) => ({
				id: m.id,
				provider: m.provider ?? 'unknown',
				displayName: m.displayName,
			}));
		} catch (error) {
			this.logger.warn('Failed to get available models: %s', error);
			return [];
		}
	}

	getModelPricing(modelId: string): ModelPricingInfo | null {
		const pricing = getModelPricing(modelId);
		if (!pricing) return null;
		return {
			modelId,
			inputPerMillion: pricing.input,
			outputPerMillion: pricing.output,
		};
	}

	getCostSummary(): CostSummary {
		const month = new Date().toISOString().slice(0, 7);
		const monthlyTotal = this.costTracker.getMonthlyTotalCost();
		const appCosts = this.costTracker.getMonthlyAppCosts();
		const perApp: Record<string, number> = {};
		for (const [appId, cost] of appCosts) {
			perApp[appId] = cost;
		}
		const userCosts = this.costTracker.getMonthlyUserCosts();
		const perUser: Record<string, number> = {};
		for (const [userId, cost] of userCosts) {
			perUser[userId] = cost;
		}
		return { month, monthlyTotal, perApp, perUser };
	}

	getScheduledJobs(): ScheduledJobInfo[] {
		const details = this.cronManager.getJobDetails();
		return details.map(({ job, key }) => ({
			key,
			appId: job.appId,
			cron: job.cron,
			description: job.description || undefined,
		}));
	}

	getSystemStatus(): SystemStatusInfo {
		return {
			uptimeSeconds: Math.floor(process.uptime()),
			appCount: this.appRegistry.getLoadedAppIds().length,
			userCount: this.userManager.getAllUsers().length,
			cronJobCount: this.cronManager.getRegisteredJobs().length,
			timezone: this.timezone,
			fallbackMode: this.fallbackMode,
		};
	}

	getSafeguardDefaults(): SafeguardInfo {
		return {
			rateLimit: {
				maxRequests: this.safeguards.defaultRateLimit.maxRequests,
				windowSeconds: this.safeguards.defaultRateLimit.windowSeconds,
			},
			appMonthlyCostCap: this.safeguards.defaultMonthlyCostCap,
			globalMonthlyCostCap: this.safeguards.globalMonthlyCostCap,
		};
	}

	async setTierModel(
		tier: string,
		provider: string,
		model: string,
	): Promise<{ success: boolean; error?: string }> {
		// Validate tier
		if (!VALID_TIERS.has(tier)) {
			return {
				success: false,
				error: `Invalid tier "${tier}". Valid tiers: fast, standard, reasoning.`,
			};
		}

		// Validate provider exists
		if (!this.providerRegistry.has(provider)) {
			const available = this.providerRegistry.getProviderIds().join(', ');
			return {
				success: false,
				error: `Provider "${provider}" not found. Available providers: ${available}.`,
			};
		}

		// Validate model ID format
		if (!MODEL_ID_PATTERN.test(model)) {
			return { success: false, error: `Invalid model ID "${model}".` };
		}

		try {
			const ref = { provider, model };
			switch (tier) {
				case 'fast':
					await this.modelSelector.setFastRef(ref);
					break;
				case 'standard':
					await this.modelSelector.setStandardRef(ref);
					break;
				case 'reasoning':
					await this.modelSelector.setReasoningRef(ref);
					break;
				default:
					break;
			}
			this.logger.info({ tier, provider, model }, 'Model tier switched via chatbot');
			return { success: true };
		} catch (error) {
			this.logger.error({ tier, provider, model, error }, 'Failed to switch model tier');
			return {
				success: false,
				error: `Failed to switch: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}
