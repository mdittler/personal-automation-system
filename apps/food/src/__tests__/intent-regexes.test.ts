/**
 * TDD Batch 4 — Phase 3: regex tightening + DataQuery verb expansion.
 */

import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage, init, isBudgetViewIntent, isMealPlanViewIntent } from '../index.js';
import { __clearShadowDepsForTests } from '../routing/shadow-integration.js';

function buildServices(
	overrides?: Partial<Parameters<typeof createMockCoreServices>[0]>,
): CoreServices {
	return createMockCoreServices({
		config: {
			get: vi.fn(async (key: string) => {
				if (key === 'shadow_sample_rate') return 0;
				if (key === 'routing_primary') return 'regex';
				return undefined;
			}),
		},
		...overrides,
	});
}

// ── isMealPlanViewIntent ──────────────────────────────────────────────────────

describe('isMealPlanViewIntent', () => {
	it('returns false for "Meal plan? I want to know about the receipt" (RC4)', () => {
		expect(isMealPlanViewIntent('Meal plan? I want to know about the receipt')).toBe(false);
	});

	// Regression guard — must be true in both RED and GREEN.
	it('returns true for "show me the meal plan"', () => {
		expect(isMealPlanViewIntent('show me the meal plan')).toBe(true);
	});

	// Regression guard — bare "meal plan" standalone command must still work.
	it('returns true for "meal plan" (standalone command)', () => {
		expect(isMealPlanViewIntent('meal plan')).toBe(true);
	});

	// Regression guard — short bare alternative.
	it('returns true for "weekly plan"', () => {
		expect(isMealPlanViewIntent('weekly plan')).toBe(true);
	});
});

// ── isBudgetViewIntent ────────────────────────────────────────────────────────

describe('isBudgetViewIntent', () => {
	it('returns false for "How much did the doctor cost?" (RC5)', () => {
		expect(isBudgetViewIntent('How much did the doctor cost?')).toBe(false);
	});

	// Regression guard — must be true in both RED and GREEN.
	it('returns true for "How much did I spend on groceries this week?"', () => {
		expect(isBudgetViewIntent('How much did I spend on groceries this week?')).toBe(true);
	});

	// Regression guard.
	it('returns true for "how much did we spend on food"', () => {
		expect(isBudgetViewIntent('how much did we spend on food')).toBe(true);
	});
});

// ── DataQuery gate expansion ──────────────────────────────────────────────────

describe('DataQuery gate expansion (RC6)', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = buildServices({
			dataQuery: {
				query: vi.fn().mockResolvedValue({ files: [], empty: true }),
			},
			interactionContext: {
				getRecent: vi.fn().mockReturnValue([]),
				record: vi.fn(),
			},
		});
		await init(services);
		__clearShadowDepsForTests();
	});

	it('calls dataQuery.query for a question ending with "?" that uses excluded verbs (RC6)', async () => {
		const ctx = createTestMessageContext({ text: 'Can you describe my food history?' });
		await handleMessage(ctx);
		expect(services.dataQuery?.query).toHaveBeenCalled();
	});

	it('calls dataQuery.query for another question with excluded verb (RC6)', async () => {
		const ctx = createTestMessageContext({ text: 'Could you explain my recent Costco trips?' });
		await handleMessage(ctx);
		expect(services.dataQuery?.query).toHaveBeenCalled();
	});
});
