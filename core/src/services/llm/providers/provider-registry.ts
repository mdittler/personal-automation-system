/**
 * Provider registry.
 *
 * Holds all instantiated LLM provider clients, keyed by provider ID.
 * Provides model listing across all providers.
 */

import type { Logger } from 'pino';
import type { LLMProviderClient, ProviderModel } from '../../../types/llm.js';

export class ProviderRegistry {
	private readonly providers = new Map<string, LLMProviderClient>();
	private readonly logger: Logger;

	constructor(logger: Logger) {
		this.logger = logger;
	}

	/** Register a provider. Overwrites any existing provider with the same ID. */
	register(provider: LLMProviderClient): void {
		this.providers.set(provider.providerId, provider);
		this.logger.info(
			{ providerId: provider.providerId, providerType: provider.providerType },
			'Provider registered',
		);
	}

	/** Get a provider by ID. Returns undefined if not registered. */
	get(providerId: string): LLMProviderClient | undefined {
		return this.providers.get(providerId);
	}

	/** Get all registered providers. */
	getAll(): LLMProviderClient[] {
		return [...this.providers.values()];
	}

	/** Get all registered provider IDs. */
	getProviderIds(): string[] {
		return [...this.providers.keys()];
	}

	/** Check if a provider is registered. */
	has(providerId: string): boolean {
		return this.providers.has(providerId);
	}

	/** Number of registered providers. */
	get size(): number {
		return this.providers.size;
	}

	/**
	 * Get all available models across all providers.
	 * Failures in individual providers are logged and skipped.
	 */
	async getAllModels(): Promise<ProviderModel[]> {
		const results: ProviderModel[] = [];

		const promises = this.getAll().map(async (provider) => {
			try {
				return await provider.listModels();
			} catch (err) {
				this.logger.warn(
					{
						providerId: provider.providerId,
						error: err instanceof Error ? err.message : String(err),
					},
					'Failed to list models from provider',
				);
				return [];
			}
		});

		const modelLists = await Promise.all(promises);
		for (const models of modelLists) {
			results.push(...models);
		}

		return results;
	}
}
