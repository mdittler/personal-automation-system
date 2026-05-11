/**
 * PAS classifier — dataQueryCandidate TRUE.
 *
 * Includes both deterministic-prefilter phrases (DATA_QUERY_PREFILTER in
 * pas-classifier.ts:141) and LLM-classified data queries. The prefilter
 * phrases never reach the LLM — they're tested for coverage parity in
 * dispatch.test.ts. Here we assert the OUTPUT contract.
 */

import type { PersonaCase } from '@core/types/regression.js';

const c: PersonaCase = {
	id: 'pas-data-query-positive',
	description: 'classifyPASMessage — dataQueryCandidate: true (prefilter + LLM paths)',
	bucket: 'routing',
	routingTarget: 'pas',
	coverage: ['core/src/services/conversation/pas-classifier.ts'],
	inputs: [
		// Deterministic-prefilter hits (no LLM call)
		'how much did we spend at Costco',
		"what's the cheapest milk",
		'last trip to Whole Foods',
		'previous receipt totals',
		// LLM-classified data queries
		'what did I eat yesterday',
		'how many recipes do I have saved',
		"what's in my pantry right now",
	].map((payload) => ({
		payload,
		expected: {
			schema: {
				type: 'object',
				required: ['pasRelated', 'dataQueryCandidate'],
				properties: {
					pasRelated: { type: 'boolean', const: true },
					dataQueryCandidate: { type: 'boolean', const: true },
				},
			},
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.05,
};

export default c;
