/**
 * PAS classifier — pasRelated FALSE.
 *
 * Pure social/general-knowledge messages should not engage the PAS-aware
 * chatbot path. (Note: classifyPASMessage is fail-open — on LLM error it
 * returns pasRelated: true. These cases assert the *normal-path* output,
 * not the failure mode.)
 */

import type { PersonaCase } from '@core/types/regression.js';

const c: PersonaCase = {
	id: 'pas-pas-related-negative',
	description: 'classifyPASMessage — pasRelated: false for social/general messages',
	bucket: 'routing',
	routingTarget: 'pas',
	coverage: ['core/src/services/conversation/pas-classifier.ts'],
	inputs: [
		"what's the weather like today",
		'tell me a joke',
		'how are you doing',
		'good morning',
		"what's the capital of france",
	].map((payload) => ({
		payload,
		expected: {
			schema: {
				type: 'object',
				required: ['pasRelated'],
				properties: {
					pasRelated: { type: 'boolean', const: false },
				},
			},
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.05,
};

export default c;
