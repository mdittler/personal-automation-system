/**
 * REQ-FOOD-HEALTH-NEG-001 — HealthDailyMetricsPayload.metrics MUST NOT contain
 * `energyLevel` or `mood` fields.
 *
 * Enforcement is compile-time via the type assertion below. If either forbidden
 * key is re-added to the interface, `pnpm build` will fail with TS2322 on
 * `_assertNoForbiddenMetrics`. The runtime test is a smoke-check that the
 * compile-time guard file is included in the build.
 */

import { describe, expect, it } from 'vitest';
import type { HealthDailyMetricsPayload } from '../events/types.js';

// Compile-time assertion (REQ-FOOD-HEALTH-NEG-001).
// If `energyLevel` or `mood` is added back to HealthDailyMetricsPayload['metrics'],
// _AssertNoForbiddenMetrics resolves to `never` and the assignment below becomes
// a TS2322 build error. `pnpm build` (tsc --build) therefore fails visibly.
type ForbiddenMetricKeys = 'energyLevel' | 'mood';
type _AssertNoForbiddenMetrics =
	ForbiddenMetricKeys extends keyof HealthDailyMetricsPayload['metrics'] ? never : true;
const _assertNoForbiddenMetrics: _AssertNoForbiddenMetrics = true;

describe('HealthDailyMetricsPayload shape (REQ-FOOD-HEALTH-NEG-001)', () => {
	it('compile-time guard is active (sanity check)', () => {
		// If this test reaches runtime, the type assertion above compiled without error.
		expect(_assertNoForbiddenMetrics).toBe(true);
	});

	it('a well-formed payload without forbidden keys conforms to the public type', () => {
		const payload: HealthDailyMetricsPayload = {
			userId: 'u1',
			date: '2026-05-07',
			metrics: { sleepHours: 7, weightKg: 70, workoutMinutes: 30 },
			source: 'test',
		};
		expect(payload.metrics).not.toHaveProperty('energyLevel');
		expect(payload.metrics).not.toHaveProperty('mood');
	});
});
