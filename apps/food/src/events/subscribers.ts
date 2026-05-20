/**
 * Health event subscriber — persists inbound health:daily-metrics events
 * from other PAS apps (e.g. a future fitness app) into per-user health store.
 *
 * Called from init() in apps/food/src/index.ts.
 */

import type { CoreServices } from '@pas/core/types';
import { upsertDailyHealth } from '../services/health-store.js';
import type { HealthDailyMetricsPayload } from './types.js';

/**
 * Register all health-related EventBus subscribers.
 * Must be called once during app init() with the injected CoreServices.
 */
export function registerHealthSubscribers(services: CoreServices): void {
	services.eventBus!.on('health:daily-metrics', async (raw: unknown) => {
		try {
			if (!isHealthDailyMetrics(raw)) {
				return; // silently drop bad payloads
			}

			const payload = raw as HealthDailyMetricsPayload;
			const userStore = services.data.forUser(payload.userId);

			// strip subjective-signal keys that untyped callers could inject at runtime
			const metrics = Object.fromEntries(
				Object.entries(payload.metrics as Record<string, unknown>).filter(
					([k]) => k !== 'energyLevel' && k !== 'mood',
				),
			) as HealthDailyMetricsPayload['metrics'];

			await upsertDailyHealth(userStore, payload.userId, {
				date: payload.date,
				metrics,
				source: payload.source,
			});
		} catch (err) {
			services.logger.warn('health:daily-metrics handler failed: %s', err);
		}
	});
}

function isHealthDailyMetrics(value: unknown): value is HealthDailyMetricsPayload {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v['userId'] === 'string' &&
		typeof v['date'] === 'string' &&
		typeof v['source'] === 'string' &&
		typeof v['metrics'] === 'object' &&
		v['metrics'] !== null
	);
}
