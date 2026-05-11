/**
 * PAS classifier — pasRelated TRUE.
 *
 * Messages that ask about the system's apps, configuration, or stored
 * data should classify as PAS-related (system-aware chatbot path).
 */

import type { PersonaCase } from '@core/types/regression.js';

const c: PersonaCase = {
	id: 'pas-pas-related-positive',
	description: 'classifyPASMessage — pasRelated: true for system-relevant queries',
	bucket: 'routing',
	routingTarget: 'pas',
	coverage: ['core/src/services/conversation/pas-classifier.ts'],
	inputs: [
		'what apps do I have installed?',
		'show me my system logs',
		'how do I configure auto-detect PAS?',
		'list my scheduled alerts',
		'what does my model journal say',
	].map((payload) => ({
		payload,
		expected: {
			schema: {
				type: 'object',
				required: ['pasRelated'],
				properties: {
					pasRelated: { type: 'boolean', const: true },
				},
			},
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.05,
};

export default c;
