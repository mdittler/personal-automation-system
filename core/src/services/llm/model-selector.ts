/**
 * Runtime model selector.
 *
 * Stores the active model for each tier as a ModelRef (provider + model).
 * Persists selection to data/system/model-selection.yaml
 * so it survives restarts. Falls back to config defaults
 * when no saved selection exists.
 *
 * Auto-migrates old format (bare model strings) on first load.
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import type { ModelRef, ModelTier } from '../../types/llm.js';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';

/** New persisted format: ModelRef per tier. */
interface ModelSelectionV2 {
	standard: ModelRef;
	fast: ModelRef;
	reasoning?: ModelRef;
}

/** Old persisted format: bare model strings (pre-Phase 11). */
interface ModelSelectionV1 {
	standard: string;
	fast: string;
}

export interface ModelSelectorOptions {
	/** Data directory root. */
	dataDir: string;
	/** Default standard model ref (from config). */
	defaultStandard: ModelRef;
	/** Default fast model ref (from config). */
	defaultFast: ModelRef;
	/** Default reasoning model ref (from config, optional). */
	defaultReasoning?: ModelRef;
	logger: Logger;
}

export class ModelSelector {
	private standard: ModelRef;
	private fast: ModelRef;
	private reasoning: ModelRef | undefined;
	private readonly filePath: string;
	private readonly logger: Logger;

	constructor(options: ModelSelectorOptions) {
		this.standard = options.defaultStandard;
		this.fast = options.defaultFast;
		this.reasoning = options.defaultReasoning;
		this.filePath = join(options.dataDir, 'system', 'model-selection.yaml');
		this.logger = options.logger;
	}

	/**
	 * Load saved model selection from disk.
	 * Call once during startup. Falls back to defaults if file doesn't exist.
	 * Auto-migrates old string-based format to ModelRef format.
	 */
	async load(): Promise<void> {
		const saved = await readYamlFile<ModelSelectionV2 | ModelSelectionV1>(this.filePath);
		if (!saved) return;

		// Detect old format (bare strings) vs new format (ModelRef objects)
		if (typeof saved.standard === 'string' || typeof saved.fast === 'string') {
			// Migrate V1 → V2
			const v1 = saved as ModelSelectionV1;
			if (v1.standard) {
				this.standard = { provider: this.standard.provider, model: v1.standard };
			}
			if (v1.fast) {
				this.fast = { provider: this.fast.provider, model: v1.fast };
			}
			this.logger.info(
				{ standard: this.standard, fast: this.fast },
				'Migrated model selection from old format',
			);
			// Re-save in new format
			await this.save();
		} else {
			// V2 format
			const v2 = saved as ModelSelectionV2;
			if (v2.standard?.provider && v2.standard?.model) {
				this.standard = v2.standard;
			}
			if (v2.fast?.provider && v2.fast?.model) {
				this.fast = v2.fast;
			}
			if (v2.reasoning?.provider && v2.reasoning?.model) {
				this.reasoning = v2.reasoning;
			}
			this.logger.info(
				{ standard: this.standard, fast: this.fast },
				'Loaded saved model selection',
			);
		}
	}

	// -----------------------------------------------------------------------
	// ModelRef getters (new API)
	// -----------------------------------------------------------------------

	/** Get the standard tier ModelRef (returns a copy). */
	getStandardRef(): ModelRef {
		return { ...this.standard };
	}

	/** Get the fast tier ModelRef (returns a copy). */
	getFastRef(): ModelRef {
		return { ...this.fast };
	}

	/** Get the reasoning tier ModelRef (may be undefined, returns a copy). */
	getReasoningRef(): ModelRef | undefined {
		return this.reasoning ? { ...this.reasoning } : undefined;
	}

	/** Get the ModelRef for a given tier (returns a copy). */
	getTierRef(tier: ModelTier): ModelRef | undefined {
		switch (tier) {
			case 'fast':
				return { ...this.fast };
			case 'standard':
				return { ...this.standard };
			case 'reasoning':
				return this.reasoning ? { ...this.reasoning } : undefined;
		}
	}

	// -----------------------------------------------------------------------
	// String getters (backward compat — used by existing GUI and LLMService)
	// -----------------------------------------------------------------------

	/** @deprecated Use getStandardRef() instead. */
	getStandardModel(): string {
		return this.standard.model;
	}

	/** @deprecated Use getFastRef() instead. */
	getFastModel(): string {
		return this.fast.model;
	}

	// -----------------------------------------------------------------------
	// Setters
	// -----------------------------------------------------------------------

	/** Set the standard tier to a specific provider + model. */
	async setStandardRef(ref: ModelRef): Promise<void> {
		this.standard = ref;
		await this.save();
		this.logger.info({ standard: ref }, 'Standard tier updated');
	}

	/** Set the fast tier to a specific provider + model. */
	async setFastRef(ref: ModelRef): Promise<void> {
		this.fast = ref;
		await this.save();
		this.logger.info({ fast: ref }, 'Fast tier updated');
	}

	/** Set the reasoning tier to a specific provider + model. */
	async setReasoningRef(ref: ModelRef): Promise<void> {
		this.reasoning = ref;
		await this.save();
		this.logger.info({ reasoning: ref }, 'Reasoning tier updated');
	}

	/**
	 * Set the standard model ID (keeps the current provider).
	 * @deprecated Use setStandardRef() instead.
	 */
	async setStandardModel(modelId: string): Promise<void> {
		this.standard = { ...this.standard, model: modelId };
		await this.save();
		this.logger.info({ standard: modelId }, 'Standard model updated');
	}

	/**
	 * Set the fast model ID (keeps the current provider).
	 * @deprecated Use setFastRef() instead.
	 */
	async setFastModel(modelId: string): Promise<void> {
		this.fast = { ...this.fast, model: modelId };
		await this.save();
		this.logger.info({ fast: modelId }, 'Fast model updated');
	}

	private async save(): Promise<void> {
		const selection: ModelSelectionV2 = {
			standard: this.standard,
			fast: this.fast,
		};
		if (this.reasoning) {
			selection.reasoning = this.reasoning;
		}
		await writeYamlFile(this.filePath, selection);
	}
}
