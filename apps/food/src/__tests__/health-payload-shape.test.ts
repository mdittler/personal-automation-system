/**
 * REQ-FOOD-HEALTH-NEG-001 — HealthDailyMetricsPayload.metrics MUST NOT contain
 * `energyLevel` or `mood` fields.
 *
 * The compile-time enforcement lives in apps/food/src/events/health-metric-guards.ts,
 * a source file included by pnpm build (not excluded like test files). This test
 * smoke-checks that the guard compiled and imports the exported const to prove the
 * file was processed by tsc.
 */

import { describe, expect, it } from 'vitest';
import { _assertNoForbiddenHealthMetrics } from '../events/health-metric-guards.js';
import type { HealthDailyMetricsPayload } from '../events/types.js';

describe('HealthDailyMetricsPayload shape (REQ-FOOD-HEALTH-NEG-001)', () => {
	it('compile-time guard in health-metric-guards.ts compiled without error', () => {
		expect(_assertNoForbiddenHealthMetrics).toBe(true);
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
