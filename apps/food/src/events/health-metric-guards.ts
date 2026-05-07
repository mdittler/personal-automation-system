import type { HealthDailyMetricsPayload } from './types.js';

// REQ-FOOD-HEALTH-NEG-001: If energyLevel or mood is re-added to
// HealthDailyMetricsPayload['metrics'], Extract<...> is no longer `never`
// and pnpm build fails here with TS2322. Uses Extract so reintroducing
// either key alone (not just the full union) is also caught.
type _ForbiddenMetricKeys = 'energyLevel' | 'mood';
export const _assertNoForbiddenHealthMetrics: Extract<
	keyof HealthDailyMetricsPayload['metrics'],
	_ForbiddenMetricKeys
> extends never
	? true
	: never = true;
