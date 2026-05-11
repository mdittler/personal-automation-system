/**
 * PAS classifier — settingsCandidate TRUE.
 *
 * Messages that ask about or request a change to PAS settings (model
 * tier, auto-detect, timezone, etc.) should classify as
 * settingsCandidate. classifyPASMessage gates this on pasRelated also
 * being true, so both fields must be set.
 */

import type { PersonaCase } from '@core/types/regression.js';

const c: PersonaCase = {
	id: 'pas-settings-positive',
	description: 'classifyPASMessage — settingsCandidate: true for config-change queries',
	bucket: 'routing',
	routingTarget: 'pas',
	coverage: ['core/src/services/conversation/pas-classifier.ts'],
	inputs: [
		'change my fast model',
		'set my timezone to UTC',
		'toggle auto-detect PAS',
		'what is my current standard model',
		'switch the reasoning tier to claude-opus',
	].map((payload) => ({
		payload,
		expected: {
			schema: {
				type: 'object',
				required: ['pasRelated', 'settingsCandidate'],
				properties: {
					pasRelated: { type: 'boolean', const: true },
					settingsCandidate: { type: 'boolean', const: true },
				},
			},
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.05,
};

export default c;
