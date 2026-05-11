/**
 * Session-control routing case: explicit prefilter commands.
 *
 * `/newchat`, `/new`, `/reset` hit the prefilter in
 * `preFilterSessionControl` (no LLM call). Strict expectation:
 * `intent: 'new_session'` with `source: 'prefilter'` and `confidence: 1.0`.
 */

import type { PersonaCase } from '@core/types/regression.js';
import { SESSION_CONTROL_SCHEMA } from '../_schemas.js';

const c: PersonaCase = {
	id: 'session-control-prefilter-commands',
	description: 'detectSessionControl — explicit /newchat /new /reset commands hit the prefilter',
	bucket: 'routing',
	routingTarget: 'session-control',
	coverage: ['core/src/services/conversation/session-control-classifier.ts'],
	inputs: ['/newchat', '/new', '/reset'].map((payload) => ({
		payload,
		expected: {
			schema: SESSION_CONTROL_SCHEMA,
			strings: [
				{ path: 'intent', expectedCaseInsensitive: 'new_session' },
				{ path: 'source', expectedCaseInsensitive: 'prefilter' },
			],
			scalars: [{ path: 'confidence', expected: 1.0, tolerance: 0 }],
		},
	})),
	oracle: 'structural',
	budgetUsd: 0.01,
};

export default c;
