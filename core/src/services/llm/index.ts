/**
 * LLM service.
 *
 * Multi-provider LLM service that routes completion requests through
 * the ProviderRegistry based on tier or explicit ModelRef.
 *
 * Model selection priority:
 *   1. options.modelRef — explicit provider + model
 *   2. options.tier — resolve via ModelSelector
 *   3. options.model === 'claude' → tier 'standard' (backward compat)
 *   4. options.model === 'local' → tier 'fast' (backward compat)
 *   5. Default → tier 'fast'
 *
 * classify() and extractStructured() always use the fast tier.
 */

import type { Logger } from 'pino';
import type {
	ClassifyResult,
	LLMClient,
	LLMCompletionOptions,
	LLMService,
	ModelRef,
	ModelTier,
} from '../../types/llm.js';
import { classify } from './classify.js';
import type { CostTracker } from './cost-tracker.js';
import { extractStructured } from './extract-structured.js';
import type { ModelSelector } from './model-selector.js';
import type { ProviderRegistry } from './providers/provider-registry.js';

export interface LLMServiceOptions {
	/** Provider registry with all instantiated provider clients. */
	registry: ProviderRegistry;
	/** Runtime model selector (tier → ModelRef mapping). */
	modelSelector: ModelSelector;
	/** Cost tracker instance (shared with providers). */
	costTracker: CostTracker;
	/** Logger instance. */
	logger: Logger;
}

export class LLMServiceImpl implements LLMService {
	private readonly registry: ProviderRegistry;
	private readonly modelSelector: ModelSelector;
	readonly costTracker: CostTracker;
	private readonly logger: Logger;

	constructor(options: LLMServiceOptions) {
		this.registry = options.registry;
		this.modelSelector = options.modelSelector;
		this.costTracker = options.costTracker;
		this.logger = options.logger;
	}

	async complete(prompt: string, options?: LLMCompletionOptions): Promise<string> {
		const ref = this.resolveModelRef(options);
		const provider = this.registry.get(ref.provider);

		if (!provider) {
			throw new Error(
				`LLM provider '${ref.provider}' is not registered. Available: ${this.registry.getProviderIds().join(', ') || '(none)'}`,
			);
		}

		this.logger.debug({ provider: ref.provider, model: ref.model }, 'Routing completion request');

		// Pass the resolved model via modelRef so the provider uses it
		const result = await provider.completeWithUsage(prompt, {
			...options,
			modelRef: ref,
		});

		return result.text;
	}

	async classify(text: string, categories: string[]): Promise<ClassifyResult> {
		return classify(text, categories, this.getFastClient(), this.logger);
	}

	async extractStructured<T>(text: string, schema: object): Promise<T> {
		return extractStructured<T>(text, schema, this.getFastClient(), this.logger);
	}

	getModelForTier(tier: ModelTier): string {
		const ref = this.modelSelector.getTierRef(tier);
		if (!ref) return 'unknown';
		return `${ref.provider}/${ref.model}`;
	}

	/**
	 * Resolve completion options to a concrete ModelRef.
	 *
	 * Priority:
	 *   1. options.modelRef — explicit provider + model
	 *   2. options.tier — resolve via ModelSelector
	 *   3. options.model === 'claude' → standard tier (backward compat)
	 *   4. options.model === 'local' → fast tier (backward compat)
	 *   5. Default → fast tier
	 */
	private resolveModelRef(options?: LLMCompletionOptions): ModelRef {
		// 1. Explicit modelRef
		if (options?.modelRef?.provider && options.modelRef.model) {
			return options.modelRef;
		}

		// 2. Semantic tier
		if (options?.tier) {
			const ref = this.modelSelector.getTierRef(options.tier);
			if (!ref) {
				throw new Error(`No model configured for tier '${options.tier}'`);
			}
			return ref;
		}

		// 3-4. Legacy model option
		if (options?.model === 'claude') {
			// Legacy 'claude' → standard tier
			const ref = this.modelSelector.getStandardRef();
			// Allow claudeModel override for backward compat
			if (options.claudeModel) {
				return { provider: ref.provider, model: options.claudeModel };
			}
			return ref;
		}

		// 'local' or default → fast tier
		return this.modelSelector.getFastRef();
	}

	/**
	 * Get an LLMClient for fast tasks (classify/extract).
	 * Reads the fast tier at call time so runtime model switching works.
	 */
	private getFastClient(): LLMClient {
		return {
			complete: (prompt, opts) => {
				const ref = this.modelSelector.getFastRef();
				const provider = this.registry.get(ref.provider);

				if (!provider) {
					throw new Error(`Fast tier provider '${ref.provider}' is not registered`);
				}

				return provider.complete(prompt, { ...opts, modelRef: ref });
			},
		};
	}
}

export { CostTracker } from './cost-tracker.js';
export { OllamaClient } from './ollama-client.js';
export { ClaudeClient } from './claude-client.js';
export { withRetry } from './retry.js';
