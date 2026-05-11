/**
 * Session-control routing case: messages that should NOT trigger new-session.
 *
 * Strict expectation: `intent: 'continue'`. Includes meta-questions about
 * the /newchat command, negations of "start over", and ordinary user
 * messages that share keywords with new-session phrases. Strict
 * expectations here catch classifier drift in both directions.
 */

import type { PersonaCase } from '@core/types/regression.js';
import { SESSION_CONTROL_SCHEMA } from '../_schemas.js';

const c: PersonaCase = {
	id: 'session-control-continue',
	description: 'detectSessionControl — meta/negation/ordinary phrasings classify as continue',
	bucket: 'routing',
	routingTarget: 'session-control',
	coverage: ['core/src/services/conversation/session-control-classifier.ts'],
	inputs: [
		// Meta-questions about the command itself. The phrase below is
		// unambiguous — "what does X do" is a documentation question, not an
		// invocation. The borderline phrase "how do I start a new chat" was
		// removed because a reasonable LLM could read it as a new-session
		// request.
		'what does /newchat do?',
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
			schema: SESSION_CONTROL_SCHEMA,
			strings: [{ path: 'intent', expectedCaseInsensitive: 'continue' }],
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.05,
};

export default c;
