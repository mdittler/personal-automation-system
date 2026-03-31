/**
 * Rule parser for markdown condition rule files.
 *
 * Parses rules in this format (from PAS-APP-SPEC-001 Section 7):
 *
 * ## rule-id
 * - **Condition:** human-readable expression
 * - **Data:** `path/to/data.md`
 * - **Action:** Send Telegram message: "..."
 * - **Cooldown:** 48 hours
 * - **Last fired:** 2026-02-25T18:00:00Z
 *
 * Rules with "fuzzy:" prefix on the ID use local LLM for evaluation.
 */

import type { Rule } from '../../types/condition.js';
import { parseCooldown } from './cooldown-tracker.js';

/**
 * Parse a markdown rule file into an array of Rule objects.
 *
 * @param content - The full text content of the rule file
 * @returns Array of parsed rules
 */
export function parseRuleFile(content: string): Rule[] {
	const rules: Rule[] = [];
	const lines = content.split('\n');

	let currentRule: Partial<Rule> | null = null;
	let rawId = '';

	for (const line of lines) {
		const trimmed = line.trim();

		// New rule: ## heading
		const headingMatch = trimmed.match(/^##\s+(.+)$/);
		if (headingMatch) {
			// Save previous rule if complete
			if (currentRule && rawId) {
				const parsed = finalizeRule(currentRule, rawId);
				if (parsed) rules.push(parsed);
			}

			rawId = headingMatch[1]?.trim() ?? '';
			const isFuzzy = rawId.startsWith('fuzzy:');
			const id = isFuzzy ? rawId.slice(6).trim() : rawId;

			currentRule = {
				id,
				isFuzzy,
				dataSources: [],
			};
			continue;
		}

		if (!currentRule) continue;

		// Parse fields
		const conditionMatch = trimmed.match(/^\-\s+\*\*Condition:\*\*\s*(.+)$/);
		if (conditionMatch) {
			currentRule.condition = conditionMatch[1]?.trim() ?? '';
			continue;
		}

		const dataMatch = trimmed.match(/^\-\s+\*\*Data:\*\*\s*(.+)$/);
		if (dataMatch) {
			const dataStr = dataMatch[1]?.trim() ?? '';
			// Extract backtick-wrapped paths, or split by comma
			const paths = dataStr.match(/`([^`]+)`/g);
			if (paths) {
				currentRule.dataSources = paths.map((p) => p.replace(/`/g, ''));
			} else {
				currentRule.dataSources = dataStr
					.split(',')
					.map((p) => p.trim())
					.filter(Boolean);
			}
			continue;
		}

		const actionMatch = trimmed.match(/^\-\s+\*\*Action:\*\*\s*(.+)$/);
		if (actionMatch) {
			currentRule.action = actionMatch[1]?.trim() ?? '';
			continue;
		}

		const cooldownMatch = trimmed.match(/^\-\s+\*\*Cooldown:\*\*\s*(.+)$/);
		if (cooldownMatch) {
			const cooldownStr = cooldownMatch[1]?.trim() ?? '';
			currentRule.cooldown = cooldownStr;
			currentRule.cooldownMs = parseCooldown(cooldownStr);
			continue;
		}

		const lastFiredMatch = trimmed.match(/^\-\s+\*\*Last fired:\*\*\s*(.+)$/);
		if (lastFiredMatch) {
			const dateStr = lastFiredMatch[1]?.trim() ?? '';
			if (dateStr && dateStr !== 'never') {
				currentRule.lastFired = new Date(dateStr);
			} else {
				currentRule.lastFired = null;
			}
		}
	}

	// Don't forget the last rule
	if (currentRule && rawId) {
		const parsed = finalizeRule(currentRule, rawId);
		if (parsed) rules.push(parsed);
	}

	return rules;
}

/**
 * Finalize a partially parsed rule, filling in defaults.
 */
function finalizeRule(partial: Partial<Rule>, _rawId: string): Rule | null {
	if (!partial.id || !partial.condition) return null;

	return {
		id: partial.id,
		condition: partial.condition,
		dataSources: partial.dataSources ?? [],
		action: partial.action ?? '',
		cooldown: partial.cooldown ?? '24 hours',
		cooldownMs: partial.cooldownMs ?? parseCooldown('24 hours'),
		lastFired: partial.lastFired ?? null,
		isFuzzy: partial.isFuzzy ?? false,
	};
}
