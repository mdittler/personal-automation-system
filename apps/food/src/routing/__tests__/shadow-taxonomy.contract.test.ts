/**
 * Contract test — the hosting-meal-planning intent string MUST be identical
 * across every copy in the codebase (manifest.yaml literal + every TS reference).
 *
 * Background: an earlier hosting-guests intent (see git history for the
 * pre-rename text) semantically overlapped "inviting people" and let the LLM
 * intent classifier mis-route platform-invite questions to the Food hosting
 * handler at confidence >= 0.7 (bypassing route verification). The string
 * was renamed to anchor on meal/menu/dinner-party and single-sourced via
 * HOSTING_MEAL_PLANNING_INTENT so the 13+ copies cannot drift.
 *
 * Rule: pas-testing-standards — when the same domain string is duplicated
 * across multiple files (config + code + tests), a contract test must enforce
 * parity so a future edit of one copy cannot silently desync the others.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { HOSTING_MEAL_PLANNING_INTENT } from '../food-intents.js';
import { FOOD_SHADOW_LABELS, REGEX_TO_MANIFEST_MAP } from '../shadow-taxonomy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXPECTED = 'user wants to plan a meal or menu for a dinner party or guests they are hosting';
// Assembled at runtime so a ripgrep sweep for the renamed-away string returns
// zero hits — proves no consumer of the old string remains in tree.
const OLD_STRING = ['user wants to', 'plan for', 'hosting guests'].join(' ');

describe('hosting-intent string is identical across all copies (contract — pas-testing-standards)', () => {
	test('food-intents constant matches the expected target', () => {
		expect(HOSTING_MEAL_PLANNING_INTENT).toBe(EXPECTED);
	});

	test('manifest.yaml literal matches the constant and old string is gone', () => {
		const manifest = readFileSync(join(__dirname, '../../../manifest.yaml'), 'utf8');
		expect(manifest).toContain(`"${HOSTING_MEAL_PLANNING_INTENT}"`);
		expect(manifest).not.toContain(OLD_STRING);
	});

	test('shadow-taxonomy FOOD_SHADOW_LABELS tuple contains the constant', () => {
		expect(FOOD_SHADOW_LABELS).toContain(HOSTING_MEAL_PLANNING_INTENT);
		expect(FOOD_SHADOW_LABELS).not.toContain(OLD_STRING);
	});

	test('shadow-taxonomy REGEX_TO_MANIFEST_MAP.hosting equals the constant', () => {
		expect(REGEX_TO_MANIFEST_MAP.hosting).toBe(HOSTING_MEAL_PLANNING_INTENT);
	});

	test('FOOD_PERSONAS hosting persona uses the constant for its label', async () => {
		const { FOOD_PERSONAS } = await import('./shadow-classifier.personas.js');
		const hostingPersona = FOOD_PERSONAS.find((p) => p.label === HOSTING_MEAL_PLANNING_INTENT);
		expect(hostingPersona).toBeDefined();
		// No persona label should still use the old string
		expect(FOOD_PERSONAS.find((p) => p.label === OLD_STRING)).toBeUndefined();
		// And no deterministicRejectFor / advisoryNearMisses entry should reference the old string either
		for (const persona of FOOD_PERSONAS) {
			for (const r of persona.deterministicRejectFor ?? []) {
				expect(r.correctLabel).not.toBe(OLD_STRING);
			}
			for (const r of persona.advisoryNearMisses ?? []) {
				expect(r.correctLabel).not.toBe(OLD_STRING);
			}
		}
	});
});
