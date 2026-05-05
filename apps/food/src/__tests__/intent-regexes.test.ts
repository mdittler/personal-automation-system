/**
 * TDD Batch 4 — Phase 3: regex tightening + DataQuery verb expansion.
 *
 * RED:
 *   1. isMealPlanViewIntent("Meal plan? I want to know about the receipt") → true (RC4 false positive)
 *   2. isMealPlanViewIntent("show me the meal plan") → true (regression guard — must stay true)
 *   3. isBudgetViewIntent("How much did the doctor cost?") → true (RC5 false positive)
 *   4. isBudgetViewIntent("How much did I spend on groceries this week?") → true (regression guard)
 *   5. DataQuery gate does NOT open for "Can you describe my food history?" (RC6)
 *   6. DataQuery gate does NOT open for "Could you explain my recent Costco trips?" (RC6)
 *
 * GREEN:
 *   1 → false (anchored bare match prevents incidental "meal plan" in longer sentence)
 *   2 → still true (first alternative still covers explicit-verb phrases)
 *   3 → false (HOW_MUCH requires food noun)
 *   4 → still true (FOOD_CONTEXT "groceries" satisfies food noun)
 *   5 → dataQuery.query called (trailing-? check opens the gate)
 *   6 → dataQuery.query called (same)
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
	// RED: currently true (RC4 false positive). GREEN: false.
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
	// RED: currently true (RC5 false positive). GREEN: false.
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
//
// These texts do NOT match any earlier food handler and do NOT contain the current
// isDataQuestion keyword set (show|what|how much|how many|list|tell me about).
// In RED state, the gate does NOT open → dataQuery.query is not called.
// In GREEN state, the trailing-? check opens the gate → dataQuery.query IS called.

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

	// RED: dataQuery.query NOT called (no matching keyword, no trailing-? check yet).
	// GREEN: dataQuery.query IS called (trailing `?` opens the gate).
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
