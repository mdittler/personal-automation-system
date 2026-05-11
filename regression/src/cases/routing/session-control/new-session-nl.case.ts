/**
 * Session-control routing case: natural-language new-session phrasings.
 *
 * `SESSION_CONTROL_NL_EXAMPLES` from `session-control-classifier.ts` —
 * each phrase MUST classify as `intent: 'new_session'`. The prefilter
 * intentionally does NOT match NL phrasings; the LLM classifier handles
 * them (`source: 'llm'`).
 */

import { SESSION_CONTROL_NL_EXAMPLES } from '@core/services/conversation/session-control-classifier.js';
import type { PersonaCase } from '@core/types/regression.js';
import { SESSION_CONTROL_SCHEMA } from '../_schemas.js';

const c: PersonaCase = {
	id: 'session-control-nl-new-session',
	description: 'detectSessionControl — natural-language new-session phrasings via LLM classifier',
	bucket: 'routing',
	routingTarget: 'session-control',
	coverage: ['core/src/services/conversation/session-control-classifier.ts'],
	inputs: SESSION_CONTROL_NL_EXAMPLES.map((payload) => ({
		payload,
		expected: {
			schema: SESSION_CONTROL_SCHEMA,
			strings: [
				{ path: 'intent', expectedCaseInsensitive: 'new_session' },
				{ path: 'source', expectedCaseInsensitive: 'llm' },
			],
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.05,
};

export default c;
