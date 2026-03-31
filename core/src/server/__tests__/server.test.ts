import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../index.js';

const logger = pino({ level: 'silent' });

describe('createServer', () => {
	let server: Awaited<ReturnType<typeof createServer>> | undefined;

	afterEach(async () => {
		if (server) await server.close();
		server = undefined;
	});

	it('creates server successfully with default options', async () => {
		server = await createServer({ logger });

		const res = await server.inject({ method: 'GET', url: '/nonexistent' });
		// Server is functional (returns 404 for unregistered routes)
		expect(res.statusCode).toBe(404);
	});

	it('creates server with trustProxy enabled', async () => {
		server = await createServer({ logger, trustProxy: true });

		// When trustProxy is true, Fastify parses X-Forwarded-For header
		server.get('/ip', async (request) => ({ ip: request.ip }));

		const res = await server.inject({
			method: 'GET',
			url: '/ip',
			headers: { 'x-forwarded-for': '1.2.3.4' },
		});

		expect(res.json().ip).toBe('1.2.3.4');
	});

	it('ignores X-Forwarded-For when trustProxy is false', async () => {
		server = await createServer({ logger, trustProxy: false });

		server.get('/ip', async (request) => ({ ip: request.ip }));

		const res = await server.inject({
			method: 'GET',
			url: '/ip',
			headers: { 'x-forwarded-for': '1.2.3.4' },
		});

		// Without trustProxy, Fastify ignores the header and returns the socket IP
		expect(res.json().ip).not.toBe('1.2.3.4');
	});

	it('registers formbody plugin for POST parsing', async () => {
		server = await createServer({ logger, cookieSecret: 'test-secret' });

		server.post('/test', async (request) => {
			return { body: request.body };
		});

		const res = await server.inject({
			method: 'POST',
			url: '/test',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			payload: 'key=value',
		});

		expect(res.statusCode).toBe(200);
		expect(res.json().body).toEqual({ key: 'value' });
	});
});
