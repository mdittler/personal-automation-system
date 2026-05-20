/**
 * Contract tests for the Chunk B routing cases (testing-standards rule 4 — testing-standards rule 4).
 *
 * Asserts every FOOD_PERSONAS accept-phrase is represented as an input in a
 * food-shadow case (catches drift between persona dataset and generated cases),
 * every coverage path resolves to an existing file (catches dead refs after
 * file moves), and every case is uniquely named + validates.
 */

import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOOD_PERSONAS } from '@food/routing/__tests__/shadow-classifier.personas.js';
import { describe, expect, it } from 'vitest';
import { loadCases } from '../runner/case-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = resolve(HERE, '..', 'cases');
const REPO_ROOT = resolve(HERE, '..', '..', '..');

describe('routing cases contract', () => {
	it('loads cleanly (every case validates)', async () => {
		// loadCases throws on any validation failure. The fact that this resolves
		// means every case under regression/src/cases passes validatePersonaCase.
		const loaded = await loadCases(CASES_DIR);
		expect(loaded.length).toBeGreaterThan(0);
	});

	it('every case id is unique', async () => {
		const loaded = await loadCases(CASES_DIR);
		const ids = loaded.map((lc) => lc.case.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every coverage path resolves to an existing file', async () => {
		const loaded = await loadCases(CASES_DIR);
		const failures: string[] = [];
		for (const lc of loaded) {
			for (const p of lc.case.coverage) {
				try {
					await stat(resolve(REPO_ROOT, p));
				} catch {
					failures.push(`${lc.case.id}: missing coverage path ${p}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it('every FOOD_PERSONAS accept phrase is represented as an input in a food-shadow case', async () => {
		const loaded = await loadCases(CASES_DIR);
		const foodShadowInputs = new Set<string>();
		for (const lc of loaded) {
			if (lc.case.routingTarget !== 'food-shadow') continue;
			for (const i of lc.case.inputs) {
				foodShadowInputs.add(String(i.payload));
			}
		}
		const missing: string[] = [];
		for (const p of FOOD_PERSONAS) {
			for (const phrase of p.accept) {
				if (!foodShadowInputs.has(phrase)) {
					missing.push(`[${p.label}] ${phrase}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it('every FOOD_PERSONAS label has at least one food-shadow case targeting it', async () => {
		const loaded = await loadCases(CASES_DIR);
		const labelsCovered = new Set<string>();
		for (const lc of loaded) {
			if (lc.case.routingTarget !== 'food-shadow') continue;
			for (const i of lc.case.inputs) {
				const exp = (
					i.expected as { strings?: Array<{ path: string; expectedCaseInsensitive: string }> }
				).strings;
				const actionString = exp?.find((s) => s.path === 'action');
				if (actionString) labelsCovered.add(actionString.expectedCaseInsensitive.toLowerCase());
			}
		}
		const missing = FOOD_PERSONAS.filter((p) => !labelsCovered.has(p.label.toLowerCase())).map(
			(p) => p.label,
		);
		expect(missing).toEqual([]);
	});

	it('session-control cases cover the prefilter commands strictly', async () => {
		const loaded = await loadCases(CASES_DIR);
		const sc = loaded.filter((lc) => lc.case.routingTarget === 'session-control');
		expect(sc.length).toBeGreaterThanOrEqual(3);
		const allPayloads = new Set<string>();
		for (const lc of sc) {
			for (const i of lc.case.inputs) allPayloads.add(String(i.payload));
		}
		// All 3 prefilter commands must be represented somewhere in session-control cases.
		for (const cmd of ['/newchat', '/new', '/reset']) {
			expect(allPayloads.has(cmd)).toBe(true);
		}
	});

	it('pas classifier cases cover both positive AND negative for each output field', async () => {
		const loaded = await loadCases(CASES_DIR);
		const pasIds = new Set(
			loaded.filter((lc) => lc.case.routingTarget === 'pas').map((lc) => lc.case.id),
		);
		// Three positive + three negative cases per the plan.
		for (const id of [
			'pas-pas-related-positive',
			'pas-pas-related-negative',
			'pas-data-query-positive',
			'pas-data-query-negative',
			'pas-settings-positive',
			'pas-settings-negative',
		]) {
			expect(pasIds, `missing PAS case: ${id}`).toContain(id);
		}
	});
});
