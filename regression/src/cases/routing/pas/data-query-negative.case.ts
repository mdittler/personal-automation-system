/**
 * PAS classifier — dataQueryCandidate is NOT true.
 *
 * PAS-relevant messages that aren't asking for stored data. The schema
 * uses `not: { properties: { dataQueryCandidate: const: true } }` so
 * either "field absent" or "field explicitly false" both pass.
 */

import type { PersonaCase } from '@core/types/regression.js';

const c: PersonaCase = {
	id: 'pas-data-query-negative',
	description: 'classifyPASMessage — dataQueryCandidate is NOT true for non-data queries',
	bucket: 'routing',
	routingTarget: 'pas',
	coverage: ['core/src/services/conversation/pas-classifier.ts'],
	inputs: [
		'what apps are installed',
		'configure my fast model',
		'how do I install a new app',
		'how can I search our past conversations?',
	].map((payload) => ({
		payload,
		expected: {
			schema: {
				type: 'object',
				required: ['pasRelated'],
				properties: {
					pasRelated: { type: 'boolean', const: true },
					dataQueryCandidate: { type: 'boolean' },
				},
				not: {
					required: ['dataQueryCandidate'],
					properties: {
						dataQueryCandidate: { const: true },
					},
				},
			},
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.05,
};

export default c;
