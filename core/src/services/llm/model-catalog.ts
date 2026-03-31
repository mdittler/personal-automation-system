/**
 * Model catalog.
 *
 * Fetches available models from all registered providers.
 * Results are cached for 1 hour to avoid excessive API calls.
 * Falls back to Anthropic-only mode when no ProviderRegistry is available.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { ProviderModel } from '../../types/llm.js';
import { MODEL_PRICING, type ModelPricing } from './model-pricing.js';
import type { ProviderRegistry } from './providers/provider-registry.js';

export interface CatalogModel {
	id: string;
	displayName: string;
	createdAt: string;
	pricing: ModelPricing | null;
	/** Provider key (e.g. 'anthropic', 'google'). */
	provider?: string;
	/** Provider type. */
	providerType?: string;
}

export interface ModelCatalogOptions {
	/** Anthropic API key — used for legacy fallback when no registry is provided. */
	apiKey: string;
	logger: Logger;
	/** Provider registry for multi-provider model listing. */
	providerRegistry?: ProviderRegistry;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class ModelCatalog {
	private readonly client: Anthropic | null;
	private readonly providerRegistry?: ProviderRegistry;
	private readonly logger: Logger;
	private cache: CatalogModel[] | null = null;
	private cacheTimestamp = 0;

	constructor(options: ModelCatalogOptions) {
		this.logger = options.logger;
		this.providerRegistry = options.providerRegistry;

		// Create legacy Anthropic client only if no registry is provided
		if (!options.providerRegistry) {
			this.client = new Anthropic({
				apiKey: options.apiKey,
				timeout: 15_000,
			});
		} else {
			this.client = null;
		}
	}

	/**
	 * Get available models with pricing info.
	 * Returns cached result if still fresh. Fetches from providers otherwise.
	 */
	async getModels(): Promise<CatalogModel[]> {
		if (this.cache && Date.now() - this.cacheTimestamp < CACHE_TTL_MS) {
			return this.cache;
		}

		try {
			const models = await this.fetchModels();
			this.cache = models;
			this.cacheTimestamp = Date.now();
			return models;
		} catch (err) {
			this.logger.error(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to fetch models',
			);
			// Return cache even if stale, or empty array
			return this.cache ?? [];
		}
	}

	/**
	 * Force refresh the cache.
	 */
	async refresh(): Promise<CatalogModel[]> {
		this.cache = null;
		this.cacheTimestamp = 0;
		return this.getModels();
	}

	private async fetchModels(): Promise<CatalogModel[]> {
		if (this.providerRegistry) {
			return this.fetchFromRegistry();
		}
		return this.fetchFromAnthropic();
	}

	/**
	 * Fetch models from all providers via the registry.
	 */
	private async fetchFromRegistry(): Promise<CatalogModel[]> {
		if (!this.providerRegistry) return [];
		const providerModels = await this.providerRegistry.getAllModels();

		const models: CatalogModel[] = providerModels.map((pm: ProviderModel) => ({
			id: pm.id,
			displayName: pm.displayName,
			createdAt: '',
			pricing: pm.pricing,
			provider: pm.provider,
			providerType: pm.providerType,
		}));

		// Sort: models with pricing first, then alphabetically
		models.sort((a, b) => {
			if (a.pricing && !b.pricing) return -1;
			if (!a.pricing && b.pricing) return 1;
			return a.id.localeCompare(b.id);
		});

		this.logger.debug({ count: models.length }, 'Fetched models from all providers');
		return models;
	}

	/**
	 * Legacy: Fetch models from Anthropic API only.
	 * Used when no ProviderRegistry is available.
	 */
	private async fetchFromAnthropic(): Promise<CatalogModel[]> {
		if (!this.client) return [];

		const models: CatalogModel[] = [];

		for await (const model of this.client.models.list({ limit: 100 })) {
			models.push({
				id: model.id,
				displayName: model.display_name,
				createdAt: model.created_at,
				pricing: MODEL_PRICING[model.id] ?? null,
				provider: 'anthropic',
				providerType: 'anthropic',
			});
		}

		// Sort: models with pricing first, then alphabetically
		models.sort((a, b) => {
			if (a.pricing && !b.pricing) return -1;
			if (!a.pricing && b.pricing) return 1;
			return a.id.localeCompare(b.id);
		});

		this.logger.debug({ count: models.length }, 'Fetched models from Anthropic API');
		return models;
	}
}
