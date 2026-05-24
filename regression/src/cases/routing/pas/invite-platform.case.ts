/**
 * PAS classifier — platform-invite phrases must classify as pasRelated.
 *
 * Regression net for the "inviting people to the platform" misroute: phrases
 * about adding/inviting users to PAS itself were previously susceptible to
 * being captured by the Food app's hosting intent (semantic overlap on
 * "hosting" / "guests" / "having people over"). After Task 3.1 renamed the
 * Food hosting intent to anchor on meal/menu/dinner-party and Tasks 3.2/3.3
 * defaulted always-verify to that intent for text + photo, these phrases must
 * route to the PAS-aware chatbot path — never to Food.
 *
 * This case asserts the upstream PAS classifier still flags invite questions
 * as `pasRelated: true` so the chatbot serves them with system knowledge
 * (invite codes, user management) instead of falling through to a generic
 * fallback that could be mis-claimed by Food's regex/LLM routing.
 *
 * The deterministic-rejection mirror at the Food layer lives in
 * `apps/food/src/routing/__tests__/shadow-classifier.personas.ts` under the
 * HOSTING_MEAL_PLANNING_INTENT persona's `deterministicRejectFor` entries.
 */

import type { PersonaCase } from '@core/types/regression.js';

const c: PersonaCase = {
	id: 'pas-invite-platform-positive',
	description:
		'classifyPASMessage — platform-invite questions must classify as pasRelated:true (must NOT mis-route to Food hosting)',
	bucket: 'routing',
	routingTarget: 'pas',
	coverage: ['core/src/services/conversation/pas-classifier.ts'],
	inputs: [
		'Can you tell me about inviting people?',
		'how do I invite someone to PAS',
		'how do invite codes work',
		'add a new user to the platform',
		'invite my wife to use this',
		'how do I add my partner',
		'can I give my kids access',
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
