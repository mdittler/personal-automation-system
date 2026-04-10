/**
 * Photo classifier for photo message routing.
 *
 * Classifies photos by type to route to the correct app.
 * Uses caption text for classification since the local LLM is text-only.
 */

import type { Logger } from 'pino';
import type { LLMService } from '../../types/llm.js';
import type { IntentTableEntry } from '../app-registry/manifest-cache.js';

/** Result of photo classification with the owning app ID. */
export interface PhotoClassificationResult {
	appId: string;
	photoType: string;
	confidence: number;
}

export interface PhotoClassifierOptions {
	llm: LLMService;
	logger: Logger;
}

export class PhotoClassifier {
	private readonly llm: LLMService;
	private readonly logger: Logger;

	constructor(options: PhotoClassifierOptions) {
		this.llm = options.llm;
		this.logger = options.logger;
	}

	/**
	 * Classify a photo's type using its caption text.
	 *
	 * Strategy:
	 * - If no photo intents registered, returns null.
	 * - If only one app accepts photos and no caption, route directly.
	 * - If caption available, classify against photo intent categories.
	 * - If no caption and multiple apps, returns null (router should ask user).
	 */
	async classify(
		caption: string | undefined,
		photoIntentTable: IntentTableEntry[],
		confidenceThreshold: number,
	): Promise<PhotoClassificationResult | null> {
		if (photoIntentTable.length === 0) {
			this.logger.debug('No photo intents registered — skipping classification');
			return null;
		}

		// If only one app has photo intents, route directly without LLM.
		// The app itself handles photo type classification (e.g. food app uses keyword + vision).
		const uniqueApps = [...new Set(photoIntentTable.map((e) => e.appId))];
		if (uniqueApps.length === 1) {
			const singleAppId = uniqueApps[0];
			const firstEntry = photoIntentTable[0];
			if (!singleAppId || !firstEntry) return null;
			const firstCategory = firstEntry.category;
			this.logger.debug(
				{ appId: singleAppId, caption: caption ?? '(none)' },
				'Single photo app — routing directly',
			);
			return {
				appId: singleAppId,
				photoType: firstCategory,
				confidence: 1.0,
			};
		}

		// No caption and multiple apps — can't classify
		if (!caption) {
			this.logger.debug('No caption and multiple photo apps — cannot classify');
			return null;
		}

		// Classify the caption against photo intent categories
		const categories = photoIntentTable.map((e) => e.category);

		try {
			const result = await this.llm.classify(caption, categories);

			if (result.confidence < confidenceThreshold) {
				this.logger.debug(
					{
						caption,
						category: result.category,
						confidence: result.confidence,
						threshold: confidenceThreshold,
					},
					'Photo classification below confidence threshold',
				);
				return null;
			}

			const entry = photoIntentTable.find((e) => e.category === result.category);
			if (!entry) {
				this.logger.warn(
					{ category: result.category },
					'Classified photo category not found in intent table',
				);
				return null;
			}

			this.logger.debug(
				{ caption, appId: entry.appId, photoType: result.category, confidence: result.confidence },
				'Photo classified',
			);

			return {
				appId: entry.appId,
				photoType: result.category,
				confidence: result.confidence,
			};
		} catch (error) {
			this.logger.error({ error, caption }, 'Photo classification failed');
			return null;
		}
	}
}
