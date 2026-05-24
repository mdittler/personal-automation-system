/**
 * Cross-package contract — Codex Round 2 finding 4.
 *
 * Why: `core/src/services/config/defaults.ts` ships a hardcoded literal copy
 * of `HOSTING_MEAL_PLANNING_INTENT` inside `DEFAULT_ALWAYS_VERIFY_INTENTS`
 * (so fresh installs without a `routing.verification.always_verify_intents`
 * override still hard-route the Food hosting intent through verification).
 * The Food-side contract test `shadow-taxonomy.contract.test.ts` only keeps
 * Food's own copies in sync; it never reaches into core. If somebody
 * renames `HOSTING_MEAL_PLANNING_INTENT` on the Food side without also
 * editing `core/src/services/config/defaults.ts`, core's default and the
 * Food intent string will silently diverge and the always-verify hard route
 * for hosting becomes a no-op on fresh deployments.
 *
 * Workspace boundary: core CANNOT import from `apps/`. Apps CAN import from
 * `@pas/core`. So the cross-package assertion belongs on the Food side,
 * importing core's `DEFAULT_ALWAYS_VERIFY_INTENTS` constant.
 */

import { DEFAULT_ALWAYS_VERIFY_INTENTS } from '@pas/core/services/config/defaults';
import { describe, expect, test } from 'vitest';
import { HOSTING_MEAL_PLANNING_INTENT } from '../food-intents.js';

describe('cross-package contract — core default includes Food hosting intent', () => {
	test('DEFAULT_ALWAYS_VERIFY_INTENTS contains HOSTING_MEAL_PLANNING_INTENT', () => {
		expect(DEFAULT_ALWAYS_VERIFY_INTENTS).toContain(HOSTING_MEAL_PLANNING_INTENT);
	});

	test('the Food intent literal would be detected if it drifted', () => {
		// Sanity: if anyone changes HOSTING_MEAL_PLANNING_INTENT without also
		// updating core's DEFAULT_ALWAYS_VERIFY_INTENTS, the first assertion
		// fails. This second assertion makes the failure mode legible by
		// pinning the literal value the cross-package contract relies on.
		expect(HOSTING_MEAL_PLANNING_INTENT).toBe(
			'user wants to plan a meal or menu for a dinner party or guests they are hosting',
		);
	});
});
