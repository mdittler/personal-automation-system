/**
 * Health Event Subscriber Tests
 *
 * Tests for registerHealthSubscribers:
 * - Subscribes to health:daily-metrics on the EventBus
 * - Persists valid payloads to per-user health store
 * - Silently drops bad payloads (wrong shape, missing userId/date)
 * - Does not throw on persistence errors
 */

import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthDailyMetricsPayload } from '../events/types.js';
import { registerHealthSubscribers } from '../events/subscribers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function createMockStore() {
	return {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

function makeHealthPayload(overrides: Partial<HealthDailyMetricsPayload> = {}): HealthDailyMetricsPayload {
	return {
		userId: 'alice',
		date: '2026-04-10',
		metrics: { sleepHours: 7 },
		source: 'health-app',
		...overrides,
	};
}

/**
 * Capture the handler registered via services.eventBus.on('health:daily-metrics', ...)
 * so tests can invoke it directly.
 */
function captureSubscriberHandler(services: CoreServices): ((payload: unknown) => Promise<void>) {
	let capturedHandler: ((payload: unknown) => Promise<void>) | undefined;
	vi.mocked(services.eventBus!.on).mockImplementation((event, handler) => {
		if (event === 'health:daily-metrics') {
			capturedHandler = handler as (payload: unknown) => Promise<void>;
		}
	});
	return async (payload: unknown) => {
		if (!capturedHandler) throw new Error('Handler not captured — did registerHealthSubscribers run?');
		return capturedHandler(payload);
	};
}

// ─── registerHealthSubscribers ─────────────────────────────────────────────

describe('registerHealthSubscribers', () => {
	let services: CoreServices;
	let userStore: ReturnType<typeof createMockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		userStore = createMockStore();
		vi.mocked(services.data.forUser).mockReturnValue(userStore as unknown as ScopedDataStore);
	});

	it('subscribes to health:daily-metrics on the event bus', () => {
		registerHealthSubscribers(services);
		expect(services.eventBus!.on).toHaveBeenCalledWith('health:daily-metrics', expect.any(Function));
	});

	it('persists a valid health payload to the user data store', async () => {
		const callHandler = captureSubscriberHandler(services);
		registerHealthSubscribers(services);

		const payload = makeHealthPayload();
		await callHandler(payload);

		expect(services.data.forUser).toHaveBeenCalledWith('alice');
		expect(userStore.write).toHaveBeenCalledWith(
			expect.stringContaining('health/2026-04.yaml'),
			expect.any(String),
		);
	});

	it('writes the entry source field into the stored data', async () => {
		const callHandler = captureSubscriberHandler(services);
		registerHealthSubscribers(services);

		await callHandler(makeHealthPayload({ source: 'fitbit-app' }));

		const written = vi.mocked(userStore.write).mock.calls[0]![1] as string;
		expect(written).toContain('fitbit-app');
	});

	it('silently drops payloads missing userId', async () => {
		const callHandler = captureSubscriberHandler(services);
		registerHealthSubscribers(services);

		const bad = { date: '2026-04-10', metrics: {}, source: 'app' }; // no userId
		await expect(callHandler(bad)).resolves.toBeUndefined();
		expect(userStore.write).not.toHaveBeenCalled();
	});

	it('silently drops payloads missing date', async () => {
		const callHandler = captureSubscriberHandler(services);
		registerHealthSubscribers(services);

		const bad = { userId: 'alice', metrics: {}, source: 'app' }; // no date
		await expect(callHandler(bad)).resolves.toBeUndefined();
		expect(userStore.write).not.toHaveBeenCalled();
	});

	it('silently drops payloads missing metrics field', async () => {
		const callHandler = captureSubscriberHandler(services);
		registerHealthSubscribers(services);

		const bad = { userId: 'alice', date: '2026-04-10', source: 'app' }; // no metrics
		await expect(callHandler(bad)).resolves.toBeUndefined();
		expect(userStore.write).not.toHaveBeenCalled();
	});

	it('silently drops payloads where metrics is null', async () => {
		const callHandler = captureSubscriberHandler(services);
		registerHealthSubscribers(services);

		const bad = { userId: 'alice', date: '2026-04-10', source: 'app', metrics: null };
		await expect(callHandler(bad)).resolves.toBeUndefined();
		expect(userStore.write).not.toHaveBeenCalled();
	});

	it('silently drops non-object payloads', async () => {
		const callHandler = captureSubscriberHandler(services);
		registerHealthSubscribers(services);

		await expect(callHandler('not-an-object')).resolves.toBeUndefined();
		await expect(callHandler(null)).resolves.toBeUndefined();
		await expect(callHandler(42)).resolves.toBeUndefined();
		expect(userStore.write).not.toHaveBeenCalled();
	});

	it('does not throw when the store write fails', async () => {
		userStore.write.mockRejectedValue(new Error('disk full'));
		const callHandler = captureSubscriberHandler(services);
		registerHealthSubscribers(services);

		await expect(callHandler(makeHealthPayload())).resolves.toBeUndefined();
	});

	it('logs a warning when the store write fails', async () => {
		userStore.write.mockRejectedValue(new Error('disk full'));
		const callHandler = captureSubscriberHandler(services);
		registerHealthSubscribers(services);

		await callHandler(makeHealthPayload());
		expect(services.logger.warn).toHaveBeenCalled();
	});
});
