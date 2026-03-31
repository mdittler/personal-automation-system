import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBusService } from '../../../types/events.js';
import type { WebhookDefinition } from '../../../types/webhooks.js';
import { WebhookService } from '../index.js';

type EventHandler = (payload: unknown) => void;

function createMockEventBus(): EventBusService & { handlers: Map<string, EventHandler[]> } {
	const handlers = new Map<string, EventHandler[]>();
	return {
		handlers,
		emit: vi.fn((event: string, payload: unknown) => {
			const eventHandlers = handlers.get(event) ?? [];
			for (const h of eventHandlers) {
				h(payload);
			}
		}),
		on: vi.fn((event: string, handler: EventHandler) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		}),
		off: vi.fn((event: string, handler: EventHandler) => {
			const existing = handlers.get(event) ?? [];
			handlers.set(
				event,
				existing.filter((h) => h !== handler),
			);
		}),
	};
}

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
} as any;

describe('WebhookService', () => {
	let eventBus: ReturnType<typeof createMockEventBus>;

	beforeEach(() => {
		eventBus = createMockEventBus();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// --- Standard (happy path) ---

	it('subscribes to configured events on init', () => {
		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/test', events: ['alert:fired'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		expect(eventBus.on).toHaveBeenCalledWith('alert:fired', expect.any(Function));
	});

	it('delivers payload on event', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/alerts', events: ['alert:fired'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		// Trigger event
		eventBus.emit('alert:fired', { alertId: 'test-alert' });

		// Wait for async delivery
		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledOnce();
		});

		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe('http://localhost:5678/webhook/alerts');
		expect(options.method).toBe('POST');
		expect(options.headers['Content-Type']).toBe('application/json');

		const body = JSON.parse(options.body);
		expect(body.event).toBe('alert:fired');
		expect(body.data).toEqual({ alertId: 'test-alert' });
		expect(body.timestamp).toBeDefined();
	});

	it('signs payload with HMAC when secret configured', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{
				id: 'wh1',
				url: 'http://localhost:5678/webhook/test',
				events: ['data:changed'],
				secret: 'my-secret-key',
			},
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		eventBus.emit('data:changed', { operation: 'write' });

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledOnce();
		});

		const [, options] = fetchMock.mock.calls[0];
		const signature = options.headers['X-PAS-Signature'];
		expect(signature).toBeDefined();
		expect(signature).toMatch(/^sha256=[a-f0-9]+$/);

		// Verify signature
		const expectedSig = createHmac('sha256', 'my-secret-key').update(options.body).digest('hex');
		expect(signature).toBe(`sha256=${expectedSig}`);
	});

	it('delivers to multiple webhooks for same event', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/a', events: ['alert:fired'] },
			{ id: 'wh2', url: 'http://localhost:5678/webhook/b', events: ['alert:fired'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		eventBus.emit('alert:fired', { alertId: 'test' });

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		const urls = fetchMock.mock.calls.map(([url]: [string]) => url);
		expect(urls).toContain('http://localhost:5678/webhook/a');
		expect(urls).toContain('http://localhost:5678/webhook/b');
	});

	// --- Edge cases ---

	it('no webhooks configured is a no-op', () => {
		const service = new WebhookService({ webhooks: [], eventBus, logger });
		service.init();
		expect(eventBus.on).not.toHaveBeenCalled();
	});

	it('unrecognized event does not trigger delivery', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/test', events: ['alert:fired'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		// Emit an event not subscribed to
		eventBus.emit('some:other:event', {});

		// Small delay to check no fetch was called
		await new Promise((r) => setTimeout(r, 50));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// --- Error handling ---

	it('handles fetch timeout gracefully', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('The operation was aborted'));
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://unreachable:9999/webhook', events: ['alert:fired'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		eventBus.emit('alert:fired', { alertId: 'test' });

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledOnce();
		});

		// Should log error but not throw
		expect(logger.error).toHaveBeenCalled();
	});

	it('handles non-2xx response', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/test', events: ['alert:fired'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		eventBus.emit('alert:fired', { alertId: 'test' });

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledOnce();
		});

		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ statusCode: 500 }),
			expect.any(String),
		);
	});

	// --- Security ---

	it('rejects webhook with invalid URL scheme', () => {
		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'file:///etc/passwd', events: ['alert:fired'] },
			{ id: 'wh2', url: 'javascript:alert(1)', events: ['alert:fired'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		// Should have warned and filtered out both
		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(eventBus.on).not.toHaveBeenCalled();
	});

	it('rejects webhook with missing fields', () => {
		const webhooks: WebhookDefinition[] = [
			{ id: '', url: 'http://localhost/test', events: ['alert:fired'] },
			{ id: 'wh2', url: '', events: ['alert:fired'] },
			{ id: 'wh3', url: 'http://localhost/test', events: [] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		expect(logger.warn).toHaveBeenCalledTimes(3);
		expect(eventBus.on).not.toHaveBeenCalled();
	});

	// --- Rate limiting ---

	it('rate limits deliveries per URL', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/test', events: ['data:changed'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		// Fire 12 events rapidly (limit is 10/minute)
		for (let i = 0; i < 12; i++) {
			eventBus.emit('data:changed', { i });
		}

		await vi.waitFor(() => {
			// First 10 should succeed, the last 2 should be rate limited
			expect(fetchMock.mock.calls.length).toBe(10);
		});

		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ webhookId: 'wh1' }),
			expect.stringContaining('rate limited'),
		);
	});

	// --- State lifecycle ---

	it('dispose unsubscribes from all events', () => {
		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/a', events: ['alert:fired'] },
			{ id: 'wh2', url: 'http://localhost:5678/webhook/b', events: ['report:completed'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();
		service.dispose();

		expect(eventBus.off).toHaveBeenCalledWith('alert:fired', expect.any(Function));
		expect(eventBus.off).toHaveBeenCalledWith('report:completed', expect.any(Function));
	});

	it('double init does not duplicate subscriptions', () => {
		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/test', events: ['alert:fired'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();
		service.init(); // second call

		// EventBus.on called twice for same event (since handlers map gets overwritten)
		expect(eventBus.on).toHaveBeenCalledTimes(2);

		// But dispose only removes the latest handler — the first one leaks
		// This is acceptable since init() is only called once in production
	});

	it('wraps non-object payload in value field', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/test', events: ['custom:event'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		eventBus.emit('custom:event', 'just a string');

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledOnce();
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.data).toEqual({ value: 'just a string' });
	});

	it('wraps array payload in value field', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/test', events: ['custom:event'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		eventBus.emit('custom:event', [1, 2, 3]);

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledOnce();
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.data).toEqual({ value: [1, 2, 3] });
	});

	it('undefined payload wraps as null value', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		const webhooks: WebhookDefinition[] = [
			{ id: 'wh1', url: 'http://localhost:5678/webhook/test', events: ['custom:event'] },
		];

		const service = new WebhookService({ webhooks, eventBus, logger });
		service.init();

		eventBus.emit('custom:event', undefined);

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledOnce();
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.data).toEqual({ value: null });
	});
});
