/**
 * chooseSources — pure function for default source selection.
 *
 * Determines which AllowedSourceCategories to read for a given
 * ContextSnapshotOptions. Strategy:
 *   - Always include the three cheap scoped readers (context-store,
 *     interaction-context, app-metadata).
 *   - Add app-knowledge when question looks like "how do I / how to / system"
 *     flavored, or when mode is 'ask'.
 *   - Add system-info when question touches system categories (llm, costs,
 *     scheduling, system) that are not purely data-flavored.
 *   - Add the four data-query categories only when dataQueryCandidate is true
 *     (caller has already determined the question is data-flavored).
 *   - Add reports + alerts when question mentions scheduling/reports/alerts,
 *     or when mode is 'ask'.
 *   - apply explicit include overrides last (force-on or force-off per category).
 */

import { categorizeQuestion } from '../conversation/system-data.js';
import type { ContextSnapshotOptions } from './conversation-retrieval-service.js';
import type { AllowedSourceCategory } from './source-policy.js';

export function chooseSources(opts: ContextSnapshotOptions): Set<AllowedSourceCategory> {
	const selected = new Set<AllowedSourceCategory>();

	// Always include the three cheap scoped readers
	selected.add('context-store');
	selected.add('interaction-context');
	selected.add('app-metadata');

	const categories = categorizeQuestion(opts.question);
	const lower = opts.question.toLowerCase();

	// App knowledge: system/how-do-I/how-to flavored, or ask mode
	if (
		categories.has('system') ||
		lower.includes('how do i') ||
		lower.includes('how to') ||
		opts.mode === 'ask'
	) {
		selected.add('app-knowledge');
	}

	// System info: any non-data system category, or ask mode
	if (
		opts.mode === 'ask' ||
		categories.has('llm') ||
		categories.has('costs') ||
		categories.has('scheduling') ||
		categories.has('system')
	) {
		selected.add('system-info');
	}

	// Data query: gated on explicit classifier signal
	if (opts.dataQueryCandidate) {
		selected.add('user-app-data');
		selected.add('household-shared-data');
		selected.add('space-data');
		selected.add('collaboration-data');
	}

	// Reports + alerts: scheduling questions, explicit keyword mention, or ask mode
	if (
		opts.mode === 'ask' ||
		categories.has('scheduling') ||
		lower.includes('report') ||
		lower.includes('alert')
	) {
		selected.add('reports');
		selected.add('alerts');
	}

	// Apply explicit include overrides last (force-on or force-off)
	if (opts.include) {
		for (const [cat, val] of Object.entries(opts.include) as [AllowedSourceCategory, boolean][]) {
			if (val) {
				selected.add(cat);
			} else {
				selected.delete(cat);
			}
		}
	}

	return selected;
}
