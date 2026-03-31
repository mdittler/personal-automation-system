import Fastify from 'fastify';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { registerWebhookRoute } from '../webhook.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

describe('POST /webhook/telegram', () => {
	it('should call the webhook callback with the request body', async () => {
		const webhookCallback = vi.fn().mockResolvedValue(undefined);
		const app = Fastify({ logger: false });
		registerWebhookRoute(app, { webhookCallback, logger: createMockLogger() });

		const fakeUpdate = {
			update_id: 123,
			message: { text: 'hello', chat: { id: 1 } },
		};

		const response = await app.inject({
			method: 'POST',
			url: '/webhook/telegram',
			payload: fakeUpdate,
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ ok: true });
		expect(webhookCallback).toHaveBeenCalledWith(fakeUpdate);

		await app.close();
	});

	it('should return 200 even when callback throws', async () => {
		const logger = createMockLogger();
		const webhookCallback = vi.fn().mockRejectedValue(new Error('handler failed'));
		const app = Fastify({ logger: false });
		registerWebhookRoute(app, { webhookCallback, logger });

		const response = await app.inject({
			method: 'POST',
			url: '/webhook/telegram',
			payload: { update_id: 456 },
		});

		expect(response.statusCode).toBe(200);
		expect(logger.error).toHaveBeenCalled();

		await app.close();
	});

	it('should reject requests with missing secret token', async () => {
		const logger = createMockLogger();
		const webhookCallback = vi.fn().mockResolvedValue(undefined);
		const app = Fastify({ logger: false });
		registerWebhookRoute(app, { webhookCallback, webhookSecret: 'my-secret', logger });

		const response = await app.inject({
			method: 'POST',
			url: '/webhook/telegram',
			payload: { update_id: 789 },
		});

		expect(response.statusCode).toBe(401);
		expect(response.json()).toEqual({ ok: false });
		expect(webhookCallback).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();

		await app.close();
	});

	it('should reject requests with wrong secret token', async () => {
		const logger = createMockLogger();
		const webhookCallback = vi.fn().mockResolvedValue(undefined);
		const app = Fastify({ logger: false });
		registerWebhookRoute(app, { webhookCallback, webhookSecret: 'my-secret', logger });

		const response = await app.inject({
			method: 'POST',
			url: '/webhook/telegram',
			headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
			payload: { update_id: 789 },
		});

		expect(response.statusCode).toBe(401);
		expect(webhookCallback).not.toHaveBeenCalled();

		await app.close();
	});

	it('should accept requests with correct secret token', async () => {
		const webhookCallback = vi.fn().mockResolvedValue(undefined);
		const app = Fastify({ logger: false });
		registerWebhookRoute(app, {
			webhookCallback,
			webhookSecret: 'my-secret',
			logger: createMockLogger(),
		});

		const response = await app.inject({
			method: 'POST',
			url: '/webhook/telegram',
			headers: { 'x-telegram-bot-api-secret-token': 'my-secret' },
			payload: { update_id: 789 },
		});

		expect(response.statusCode).toBe(200);
		expect(webhookCallback).toHaveBeenCalledWith({ update_id: 789 });

		await app.close();
	});
});
