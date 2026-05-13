import { describe, expect, it } from 'vitest';
import type { PersonaCase } from '../shared/types.js';
import { validatePersonaCase } from '../shared/validate-case.js';

const valid: PersonaCase = {
	id: 'receipt-walmart-basic',
	description: 'd',
	bucket: 'receipt',
	coverage: ['apps/food/src/services/receipt-parser.ts'],
	inputs: [{ payload: 1, expected: 1 }],
	oracle: 'structural',
	budgetUsd: 0.05,
};

describe('validatePersonaCase', () => {
	it('passes a well-formed case', () => {
		expect(() => validatePersonaCase(valid)).not.toThrow();
	});

	it.each([
		['Receipt-Walmart', /lowercase|id/i], // uppercase
		['has spaces', /id/i],
		['', /id/i],
		['/etc/passwd', /id/i],
		['1-leading-digit', /id/i], // must start with letter
		['CamelCase', /lowercase|id/i],
	])('rejects bad id %j', (id, pattern) => {
		expect(() => validatePersonaCase({ ...valid, id })).toThrow(pattern);
	});

	it('rejects unknown bucket', () => {
		expect(() => validatePersonaCase({ ...valid, bucket: 'wat' as PersonaCase['bucket'] })).toThrow(
			/bucket/i,
		);
	});

	it('rejects empty coverage', () => {
		expect(() => validatePersonaCase({ ...valid, coverage: [] })).toThrow(/coverage/i);
	});

	it.each([
		'/abs/path.ts',
		'..\\sneaky.ts',
		'../escape.ts',
		'apps/food/../sneaky.ts',
		'C:\\windows\\path.ts',
		'C:/windows/path.ts',
	])('rejects bad coverage path %j', (p) => {
		expect(() => validatePersonaCase({ ...valid, coverage: [p] })).toThrow(
			/coverage|relative|traversal/i,
		);
	});

	it('rejects negative budget', () => {
		expect(() => validatePersonaCase({ ...valid, budgetUsd: -1 })).toThrow(/budget/i);
	});

	it('rejects zero budget', () => {
		expect(() => validatePersonaCase({ ...valid, budgetUsd: 0 })).toThrow(/budget/i);
	});

	it('rejects NaN/Infinity budget', () => {
		expect(() => validatePersonaCase({ ...valid, budgetUsd: Number.NaN })).toThrow(/budget/i);
		expect(() => validatePersonaCase({ ...valid, budgetUsd: Number.POSITIVE_INFINITY })).toThrow(
			/budget/i,
		);
	});

	it('rejects oracle: judge always (REQ-REG-014)', () => {
		expect(() => validatePersonaCase({ ...valid, oracle: 'judge' })).toThrow(/judge|reserved/i);
	});

	it('rejects empty inputs', () => {
		expect(() => validatePersonaCase({ ...valid, inputs: [] })).toThrow(/inputs/i);
	});
});

describe('validatePersonaCase — routingTarget (Chunk B)', () => {
	const validRouting: PersonaCase = {
		id: 'food-recipe-save',
		description: 'user saves a recipe',
		bucket: 'routing',
		routingTarget: 'food-shadow',
		coverage: ['apps/food/src/routing/shadow-classifier.ts'],
		inputs: [
			{
				payload: 'save this recipe',
				expected: {
					schema: { type: 'object' },
					strings: [{ path: 'action', expectedCaseInsensitive: 'user wants to save a recipe' }],
				},
			},
		],
		oracle: 'structural',
		budgetUsd: 0.05,
	};

	it('accepts a routing case with valid routingTarget', () => {
		expect(() => validatePersonaCase(validRouting)).not.toThrow();
	});

	it('throws when routing bucket has no routingTarget', () => {
		const c = { ...validRouting, routingTarget: undefined };
		expect(() => validatePersonaCase(c as PersonaCase)).toThrow(/routingTarget.*required/i);
	});

	it.each(['food-shadow', 'session-control', 'pas'] as const)(
		'accepts routingTarget=%s',
		(t) => {
			expect(() => validatePersonaCase({ ...validRouting, routingTarget: t })).not.toThrow();
		},
	);

	it('rejects unknown routingTarget value', () => {
		expect(() =>
			validatePersonaCase({
				...validRouting,
				routingTarget: 'garbage' as never,
			}),
		).toThrow(/routingTarget.*invalid|must be one of/i);
	});

	it('rejects routingTarget when bucket is not routing', () => {
		const c: PersonaCase = {
			...validRouting,
			bucket: 'receipt',
			routingTarget: 'food-shadow',
		};
		expect(() => validatePersonaCase(c)).toThrow(/routingTarget.*only.*routing/i);
	});
});

describe('Chunk C — rubric oracle rules', () => {
	const baseChatbot: Omit<PersonaCase, 'oracle' | 'rubric'> = {
		id: 'cb-rubric-test',
		description: 'rubric validation test',
		bucket: 'chatbot',
		coverage: ['core/src/services/conversation/handle-message.ts'],
		inputs: [{ payload: 'hi', expected: {} }],
		budgetUsd: 0.1,
	};

	it('accepts oracle="rubric" on a chatbot case with a non-empty rubric', () => {
		expect(() =>
			validatePersonaCase({
				...baseChatbot,
				oracle: 'rubric',
				rubric: 'Reply must mention X. Reply must not say Y.',
			}),
		).not.toThrow();
	});

	it('rejects oracle="rubric" without a rubric field', () => {
		expect(() =>
			validatePersonaCase({ ...baseChatbot, oracle: 'rubric' } as PersonaCase),
		).toThrow(/rubric.*required/i);
	});

	it('rejects oracle="rubric" with an empty rubric string', () => {
		expect(() =>
			validatePersonaCase({ ...baseChatbot, oracle: 'rubric', rubric: '   ' }),
		).toThrow(/rubric.*non-empty/i);
	});

	it('rejects oracle="rubric" on a non-chatbot bucket (recall)', () => {
		expect(() =>
			validatePersonaCase({
				...baseChatbot,
				bucket: 'recall',
				oracle: 'rubric',
				rubric: 'some rubric',
			}),
		).toThrow(/rubric.*only.*chatbot/i);
	});

	it('rejects oracle="rubric" on a routing bucket', () => {
		expect(() =>
			validatePersonaCase({
				...baseChatbot,
				bucket: 'routing',
				routingTarget: 'food-shadow',
				oracle: 'rubric',
				rubric: 'some rubric',
			}),
		).toThrow(/rubric.*only.*chatbot/i);
	});

	it('still rejects oracle="judge" (REQ-REG-014)', () => {
		expect(() =>
			validatePersonaCase({
				...baseChatbot,
				oracle: 'judge' as 'rubric',
				rubric: 'whatever',
			}),
		).toThrow(/judge.*reserved/i);
	});
});
