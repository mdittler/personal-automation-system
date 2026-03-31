/**
 * Condition evaluator service.
 *
 * Runs on a configurable schedule:
 * - Deterministic rules: every 15 minutes (URS-CE-003)
 * - LLM holistic scan: once or twice daily (URS-CE-006)
 *
 * Reads markdown rule files, evaluates conditions, respects cooldowns,
 * and triggers actions when conditions are met.
 */

import type { Logger } from 'pino';
import type { ConditionEvaluatorService, Rule, RuleStatus } from '../../types/condition.js';
import type { ScopedDataStore } from '../../types/data-store.js';
import type { LLMService } from '../../types/llm.js';
import { buildRuleStatus } from './cooldown-tracker.js';
import { evaluateRule } from './evaluator.js';
import { parseRuleFile } from './rule-parser.js';

export interface ConditionEvaluatorOptions {
	/** Data store for reading rule files and data sources. */
	dataStore: ScopedDataStore;
	/** LLM service for fuzzy evaluation. Can be null at startup. */
	llm: LLMService | null;
	/** Logger instance. */
	logger: Logger;
}

export class ConditionEvaluatorServiceImpl implements ConditionEvaluatorService {
	private rules = new Map<string, Rule>();
	private readonly ruleSourceFiles = new Map<string, string>();
	private readonly dataStore: ScopedDataStore;
	private readonly llm: LLMService | null;
	private readonly logger: Logger;

	constructor(options: ConditionEvaluatorOptions) {
		this.dataStore = options.dataStore;
		this.llm = options.llm;
		this.logger = options.logger;
	}

	/**
	 * Load rules from a markdown rule file.
	 * @param content - The file content
	 * @param sourceFile - Optional path to the source file (for writeback)
	 */
	loadRules(content: string, sourceFile?: string): void {
		const parsed = parseRuleFile(content);
		for (const rule of parsed) {
			this.rules.set(rule.id, rule);
			if (sourceFile) {
				this.ruleSourceFiles.set(rule.id, sourceFile);
			}
		}
		this.logger.info({ count: parsed.length }, 'Rules loaded');
	}

	/**
	 * Load rules from multiple rule file paths.
	 */
	async loadRuleFiles(paths: string[]): Promise<void> {
		for (const path of paths) {
			const content = await this.dataStore.read(path);
			if (content) {
				this.loadRules(content, path);
			}
		}
	}

	async evaluate(ruleId: string): Promise<boolean> {
		const rule = this.rules.get(ruleId);
		if (!rule) {
			this.logger.warn({ ruleId }, 'Rule not found for evaluation');
			return false;
		}

		const result = await evaluateRule(rule, {
			dataStore: this.dataStore,
			llm: this.llm,
			logger: this.logger,
		});

		if (result.actionTriggered) {
			rule.lastFired = new Date();
			await this.persistLastFired(rule);
		}

		return result.conditionMet;
	}

	/**
	 * Write the updated "Last fired" timestamp back to the rule's source file.
	 */
	private async persistLastFired(rule: Rule): Promise<void> {
		const sourceFile = this.ruleSourceFiles.get(rule.id);
		if (!sourceFile || !rule.lastFired) return;

		try {
			const content = await this.dataStore.read(sourceFile);
			const updated = updateLastFiredInContent(content, rule.id, rule.isFuzzy, rule.lastFired);
			await this.dataStore.write(sourceFile, updated);
		} catch (err) {
			this.logger.error(
				{ ruleId: rule.id, error: err instanceof Error ? err.message : String(err) },
				'Failed to persist Last fired timestamp',
			);
		}
	}

	async getRuleStatus(ruleId: string): Promise<RuleStatus> {
		const rule = this.rules.get(ruleId);
		if (!rule) {
			return {
				id: ruleId,
				lastFired: null,
				cooldownRemaining: 0,
				isActive: false,
			};
		}

		return buildRuleStatus(rule.id, rule.lastFired, rule.cooldownMs);
	}

	/**
	 * Evaluate all loaded rules. Used by the scheduled check.
	 */
	async evaluateAll(): Promise<void> {
		for (const rule of this.rules.values()) {
			await this.evaluate(rule.id);
		}
	}

	/**
	 * Get all loaded rules (for inspection/debugging).
	 */
	getRules(): Rule[] {
		return Array.from(this.rules.values());
	}
}

/**
 * Update the "Last fired" line for a specific rule in file content.
 * If the line doesn't exist, adds it after the last known field.
 */
export function updateLastFiredInContent(
	content: string,
	ruleId: string,
	isFuzzy: boolean,
	lastFired: Date,
): string {
	const lines = content.split('\n');
	const heading = isFuzzy ? `## fuzzy:${ruleId}` : `## ${ruleId}`;
	const timestamp = lastFired.toISOString();

	let inTargetRule = false;
	let lastFieldLineIndex = -1;
	let lastFiredLineIndex = -1;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? '';

		if (trimmed === heading) {
			inTargetRule = true;
			lastFieldLineIndex = i;
			continue;
		}

		// Hit the next rule heading — stop searching
		if (inTargetRule && /^##\s+/.test(trimmed)) {
			break;
		}

		if (inTargetRule && /^\-\s+\*\*/.test(trimmed)) {
			lastFieldLineIndex = i;
			if (/^\-\s+\*\*Last fired:\*\*/.test(trimmed)) {
				lastFiredLineIndex = i;
			}
		}
	}

	if (lastFiredLineIndex >= 0) {
		// Replace existing line
		lines[lastFiredLineIndex] = `- **Last fired:** ${timestamp}`;
	} else if (lastFieldLineIndex >= 0) {
		// Insert after the last field
		lines.splice(lastFieldLineIndex + 1, 0, `- **Last fired:** ${timestamp}`);
	}

	return lines.join('\n');
}

export { parseCooldown } from './cooldown-tracker.js';
export { parseRuleFile } from './rule-parser.js';
export { evaluateRule, evaluateDeterministic, evaluateFuzzy } from './evaluator.js';
export type { EvaluatorDeps } from './evaluator.js';
