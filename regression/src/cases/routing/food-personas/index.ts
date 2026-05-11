/**
 * Generated FOOD_PERSONAS regression cases.
 *
 * Imports `FOOD_PERSONAS` and emits one `PersonaCase` per persona label,
 * with every accept-phrase becoming an input. Adding a label or phrase
 * to the persona source automatically lands new test coverage — no
 * per-label .case.ts file to keep in sync.
 *
 * Coverage paths include the classifier, taxonomy, and the persona source
 * itself so a phrase edit invalidates only this module's cache key (REQ-REG-002).
 */

import { fileURLToPath } from 'node:url';
import { slugifyKey } from '@core/services/context-store/index.js';
import type { LoadedCase, PersonaCase } from '@core/types/regression.js';
import { FOOD_PERSONAS } from '@food/routing/__tests__/shadow-classifier.personas.js';

const HERE = fileURLToPath(import.meta.url);

const COVERAGE: readonly string[] = [
	'apps/food/src/routing/shadow-classifier.ts',
	'apps/food/src/routing/shadow-taxonomy.ts',
	'apps/food/src/routing/__tests__/shadow-classifier.personas.ts',
];

export function buildCases(): LoadedCase[] {
	const out: LoadedCase[] = [];
	for (const p of FOOD_PERSONAS) {
		// Skip empty accept arrays defensively — the persona source has them all
		// non-empty today, but a future entry could add one.
		if (p.accept.length === 0) continue;
		const c: PersonaCase = {
			id: `food-${slugifyKey(p.label)}`,
			description: `FOOD_PERSONAS — ${p.label}`,
			bucket: 'routing',
			routingTarget: 'food-shadow',
			coverage: [...COVERAGE],
			inputs: p.accept.map((phrase) => ({
				payload: phrase,
				expected: {
					schema: {
						type: 'object',
						required: ['action', 'confidence'],
						properties: {
							action: { type: 'string' },
							confidence: { type: 'number', minimum: 0, maximum: 1 },
						},
					},
					strings: [{ path: 'action', expectedCaseInsensitive: p.label }],
				},
			})),
			oracle: 'structural',
			budgetUsd: 0.05,
		};
		out.push({ case: c, filePath: HERE });
	}
	return out;
}
