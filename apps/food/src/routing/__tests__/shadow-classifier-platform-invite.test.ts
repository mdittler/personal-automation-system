import { describe, expect, it } from 'vitest';
import { HOSTING_MEAL_PLANNING_INTENT } from '../food-intents.js';
import { FOOD_PERSONAS } from './shadow-classifier.personas.js';

/**
 * REQ-CONV-PAS-CLASSIFY-005 — the new platform-invite phrasings the PAS
 * classifier now accepts (via PLATFORM_INVITE_RE) must remain on Food's
 * deterministic-reject list so Food does NOT route them to handleMessage.
 * Belt-and-suspenders against future collisions if HOSTING_MEAL_PLANNING_INTENT
 * shifts wording.
 */

describe('Food shadow-classifier — platform-invite phrasings stay rejected', () => {
	const hostingPersona = FOOD_PERSONAS.find((p) => p.label === HOSTING_MEAL_PLANNING_INTENT);

	const required = [
		'can I give my kids access',
		'how do I add my partner',
		'invite my wife to use this',
	];

	it('hosting persona exists', () => {
		expect(hostingPersona).toBeDefined();
	});

	for (const text of required) {
		it(`deterministicRejectFor includes "${text}" with correctLabel="none"`, () => {
			const entry = hostingPersona?.deterministicRejectFor.find((e) => e.text === text);
			expect(entry, `expected deterministicRejectFor to include "${text}"`).toBeDefined();
			expect(entry?.correctLabel).toBe('none');
		});
	}
});
