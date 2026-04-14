/**
 * Intent classifier for free-text message routing.
 *
 * Wraps LLMService.classify() to match user messages against
 * all registered app intents. Uses ONLY the local LLM (URS-RT-006).
 */

import type { Logger } from 'pino';
import type { LLMService } from '../../types/llm.js';
import type { IntentTableEntry } from '../app-registry/manifest-cache.js';

/** Result of intent classification with the owning app ID. */
export interface IntentClassificationResult {
	appId: string;
	intent: string;
	confidence: number;
}

export interface IntentClassifierOptions {
	llm: LLMService;
	logger: Logger;
}

export class IntentClassifier {
	private readonly llm: LLMService;
	private readonly logger: Logger;

	constructor(options: IntentClassifierOptions) {
		this.llm = options.llm;
		this.logger = options.logger;
	}

	/**
	 * Classify text against the intent table.
	 * Returns the match or null if below the confidence threshold.
	 */
	async classify(
		text: string,
		intentTable: IntentTableEntry[],
		confidenceThreshold: number,
	): Promise<IntentClassificationResult | null> {
		if (intentTable.length === 0) {
			this.logger.debug('No intents registered — skipping classification');
			return null;
		}

		const categories = intentTable.map((entry) => entry.category);

		try {
			const result = await this.llm.classify(text, categories);

			if (result.confidence < confidenceThreshold) {
				this.logger.debug(
					{
						text,
						category: result.category,
						confidence: result.confidence,
						threshold: confidenceThreshold,
					},
					'Classification below confidence threshold',
				);
				return null;
			}

			// Map the matched category back to its app ID
			const entry = intentTable.find((e) => e.category === result.category);
			if (!entry) {
				this.logger.warn(
					{ category: result.category },
					'Classified category not found in intent table',
				);
				return null;
			}

			this.logger.debug(
				{ text, appId: entry.appId, intent: result.category, confidence: result.confidence },
				'Intent classified',
			);

			return {
				appId: entry.appId,
				intent: result.category,
				confidence: result.confidence,
			};
		} catch (error) {
			this.logger.error({ error, text }, 'Intent classification failed');
			return null;
		}
	}

	/**
	 * Classify text against the intent table WITHOUT applying the confidence threshold gate.
	 *
	 * Returns the raw LLM classification result (null only on error or empty intentTable).
	 * Used for context-aware promotion: when the normal classify() returns null (below
	 * threshold), the router may call this to get the low-confidence result for comparison
	 * against recent interaction context.
	 *
	 * NOTE: This method never direct-routes. The caller is responsible for gating the
	 * result through a RouteVerifier before acting on it.
	 */
	async classifyWithLowConfidence(
		text: string,
		intentTable: IntentTableEntry[],
	): Promise<IntentClassificationResult | null> {
		if (intentTable.length === 0) {
			this.logger.debug('No intents registered — skipping low-confidence classification');
			return null;
		}

		const categories = intentTable.map((entry) => entry.category);

		try {
			const result = await this.llm.classify(text, categories);

			// Map the matched category back to its app ID
			const entry = intentTable.find((e) => e.category === result.category);
			if (!entry) {
				this.logger.debug(
					{ category: result.category },
					'Low-confidence classification: category not found in intent table',
				);
				return null;
			}

			this.logger.debug(
				{ text, appId: entry.appId, intent: result.category, confidence: result.confidence },
				'Low-confidence intent classified (threshold not applied)',
			);

			return {
				appId: entry.appId,
				intent: result.category,
				confidence: result.confidence,
			};
		} catch (error) {
			this.logger.error({ error, text }, 'Low-confidence intent classification failed');
			return null;
		}
	}
}
