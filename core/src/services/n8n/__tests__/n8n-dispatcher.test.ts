import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type N8nDispatchPayload, N8nDispatcherImpl } from '../index.js';

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
} as any;

describe('N8nDispatcher', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('enabled', () => {
		it('returns true when dispatchUrl is set', () => {
			const dispatcher = new N8nDispatcherImpl({
				dispatchUrl: 'http://localhost:5678/webhook/pas',
				logger,
			});
			expect(dispatcher.enabled).toBe(true);
		});

		it('returns false when dispatchUrl is empty', () => {
			const dispatcher = new N8nDispatcherImpl({ dispatchUrl: '', logger });
			expect(dispatcher.enabled).toBe(false);
		});

		it('returns false for non-http URL scheme', () => {
			const dispatcher = new N8nDispatcherImpl({
				dispatchUrl: 'file:///etc/passwd',
				logger,
			});
			expect(dispatcher.enabled).toBe(false);
			expect(logger.warn).toHaveBeenCalled();
		});

		it('accepts https URLs', () => {
			const dispatcher = new N8nDispatcherImpl({
				dispatchUrl: 'https://n8n.example.com/webhook/pas',
				logger,
			});
			expect(dispatcher.enabled).toBe(true);
		});
	});

	describe('dispatch', () => {
		const payload: N8nDispatchPayload = { type: 'report', id: 'weekly-review', action: 'run' };

		it('returns false when not enabled', async () => {
			const dispatcher = new N8nDispatcherImpl({ dispatchUrl: '', logger });
			const result = await dispatcher.dispatch(payload);
			expect(result).toBe(false);
		});

		it('returns true on successful dispatch (2xx)', async () => {
			const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
			vi.stubGlobal('fetch', mockFetch);

			const dispatcher = new N8nDispatcherImpl({
				dispatchUrl: 'http://localhost:5678/webhook/pas',
				logger,
			});
			const result = await dispatcher.dispatch(payload);

			expect(result).toBe(true);
			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:5678/webhook/pas',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				}),
			);
		});

		it('returns false on non-2xx response', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

			const dispatcher = new N8nDispatcherImpl({
				dispatchUrl: 'http://localhost:5678/webhook/pas',
				logger,
			});
			const result = await dispatcher.dispatch(payload);

			expect(result).toBe(false);
			expect(logger.warn).toHaveBeenCalled();
		});

		it('returns false on network error', async () => {
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

			const dispatcher = new N8nDispatcherImpl({
				dispatchUrl: 'http://localhost:5678/webhook/pas',
				logger,
			});
			const result = await dispatcher.dispatch(payload);

			expect(result).toBe(false);
			expect(logger.warn).toHaveBeenCalled();
		});

		it('dispatches alert payloads', async () => {
			const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
			vi.stubGlobal('fetch', mockFetch);

			const dispatcher = new N8nDispatcherImpl({
				dispatchUrl: 'http://localhost:5678/webhook/pas',
				logger,
			});
			const alertPayload: N8nDispatchPayload = {
				type: 'alert',
				id: 'low-stock',
				action: 'evaluate',
			};
			const result = await dispatcher.dispatch(alertPayload);

			expect(result).toBe(true);
			const body = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(body.type).toBe('alert');
			expect(body.id).toBe('low-stock');
		});

		it('dispatches daily_diff payloads', async () => {
			const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
			vi.stubGlobal('fetch', mockFetch);

			const dispatcher = new N8nDispatcherImpl({
				dispatchUrl: 'http://localhost:5678/webhook/pas',
				logger,
			});
			const result = await dispatcher.dispatch({
				type: 'daily_diff',
				id: 'daily-diff',
				action: 'run',
			});

			expect(result).toBe(true);
		});

		it('logs successful dispatches', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

			const dispatcher = new N8nDispatcherImpl({
				dispatchUrl: 'http://localhost:5678/webhook/pas',
				logger,
			});
			await dispatcher.dispatch(payload);

			expect(logger.info).toHaveBeenCalledWith(
				{ type: 'report', id: 'weekly-review', action: 'run' },
				'n8n dispatch successful',
			);
		});
	});
});
