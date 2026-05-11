/**
 * PAS classifier — settingsCandidate is NOT true.
 *
 * Data queries and recipe/meal questions that mention settings-like words
 * (e.g. "model" in a recipe context) should not trigger the settings
 * catalog injection.
 */

import type { PersonaCase } from '@core/types/regression.js';

const c: PersonaCase = {
	id: 'pas-settings-negative',
	description: 'classifyPASMessage — settingsCandidate is NOT true for non-settings queries',
	bucket: 'routing',
	routingTarget: 'pas',
	coverage: ['core/src/services/conversation/pas-classifier.ts'],
	inputs: [
		'what did I eat for breakfast',
		'save this pasta recipe',
		'show me my grocery list',
		'how many calories in this meal',
	].map((payload) => ({
		payload,
		expected: {
			schema: {
				type: 'object',
				required: ['pasRelated'],
				properties: {
					pasRelated: { type: 'boolean' },
					settingsCandidate: { type: 'boolean' },
				},
				not: {
					required: ['settingsCandidate'],
					properties: {
						settingsCandidate: { const: true },
					},
				},
			},
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.05,
};

export default c;
