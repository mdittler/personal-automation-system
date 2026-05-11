/**
 * Session-control routing case: messages that should NOT trigger new-session.
 *
 * Strict expectation: `intent: 'continue'`. Includes meta-questions about
 * the /newchat command, negations of "start over", and ordinary user
 * messages that share keywords with new-session phrases. These are the
 * cases where lenient classification would produce false positives —
 * keeping them strict catches drift in either direction (Codex C-13).
 */

import type { PersonaCase } from '@core/types/regression.js';

const c: PersonaCase = {
	id: 'session-control-continue',
	description: 'detectSessionControl — meta/negation/ordinary phrasings classify as continue',
	bucket: 'routing',
	routingTarget: 'session-control',
	coverage: ['core/src/services/conversation/session-control-classifier.ts'],
	inputs: [
		// Meta-questions about the command itself
		'what does /newchat do?',
		'how do I start a new chat',
		// Negations
		"don't start over",
		"i'm not done with this conversation",
		"please don't reset",
		// Ordinary messages with shared keywords
		"what's on the grocery list",
		'I ate pasta for lunch',
		"what's for dinner tonight",
		'show me my pantry',
		'how are you doing today',
	].map((payload) => ({
		payload,
		expected: {
			schema: {
				type: 'object',
				required: ['intent', 'confidence', 'source'],
				properties: {
					intent: { type: 'string' },
					confidence: { type: 'number', minimum: 0, maximum: 1 },
					source: { type: 'string' },
				},
			},
			strings: [{ path: 'intent', expectedCaseInsensitive: 'continue' }],
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.05,
};

export default c;
