/**
 * GUI authentication.
 *
 * Token-based auth with HTTP-only signed cookies.
 * Login page accepts the GUI_AUTH_TOKEN, sets a cookie,
 * and all subsequent requests validate the cookie.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimiter } from '../middleware/rate-limiter.js';

const COOKIE_NAME = 'pas_auth';
const COOKIE_MAX_AGE = 24 * 60 * 60; // 24 hours in seconds

export interface AuthOptions {
	authToken: string;
	loginRateLimiter?: RateLimiter;
}

/**
 * Register auth routes and middleware on the Fastify instance.
 * Must be registered as a Fastify plugin within the /gui prefix.
 */
export async function registerAuth(server: FastifyInstance, options: AuthOptions): Promise<void> {
	const { authToken, loginRateLimiter } = options;
	const cookieValue = createHmac('sha256', authToken).update('pas-gui-auth').digest('hex');

	// Login page (no auth required)
	server.get('/login', async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.viewAsync('login', { title: 'Login — PAS', error: null });
	});

	// Login handler
	server.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
		// Rate limit login attempts by IP
		if (loginRateLimiter) {
			const clientIp = request.ip;
			if (!loginRateLimiter.isAllowed(clientIp)) {
				return reply.status(429).viewAsync('login', {
					title: 'Login — PAS',
					error: 'Too many login attempts. Please try again later.',
				});
			}
		}

		const body = request.body as { token?: string } | undefined;
		const submitted = body?.token ?? '';

		// Timing-safe comparison
		const submittedBuf = Buffer.from(submitted);
		const expectedBuf = Buffer.from(authToken);

		const isValid =
			submittedBuf.length === expectedBuf.length && timingSafeEqual(submittedBuf, expectedBuf);

		if (!isValid) {
			return reply.viewAsync('login', { title: 'Login — PAS', error: 'Invalid token' });
		}

		const isSecure =
			process.env['NODE_ENV'] === 'production' || process.env['GUI_SECURE_COOKIES'] === 'true';

		reply.setCookie(COOKIE_NAME, cookieValue, {
			path: '/gui',
			httpOnly: true,
			sameSite: 'strict',
			maxAge: COOKIE_MAX_AGE,
			signed: true,
			secure: isSecure,
		});

		return reply.redirect('/gui/');
	});

	// Logout handler
	server.post('/logout', async (_request: FastifyRequest, reply: FastifyReply) => {
		const isSecure =
			process.env['NODE_ENV'] === 'production' || process.env['GUI_SECURE_COOKIES'] === 'true';
		reply.clearCookie(COOKIE_NAME, { path: '/gui', secure: isSecure });
		reply.clearCookie('pas_csrf', { path: '/gui', secure: isSecure });
		return reply.redirect('/gui/login');
	});

	// Auth guard hook — runs on all /gui/* routes except login and public assets
	server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
		const url = request.url;

		// Skip auth for login page and static assets
		if (url === '/gui/login' || url.startsWith('/gui/public/')) {
			return;
		}

		const cookie = request.cookies[COOKIE_NAME];
		if (!cookie) {
			return reply.redirect('/gui/login');
		}

		// Verify signed cookie
		const unsigned = request.unsignCookie(cookie);
		if (!unsigned.valid || unsigned.value !== cookieValue) {
			const isSecure =
				process.env['NODE_ENV'] === 'production' || process.env['GUI_SECURE_COOKIES'] === 'true';
			reply.clearCookie(COOKIE_NAME, { path: '/gui', secure: isSecure });
			return reply.redirect('/gui/login');
		}

		// Reissue cookie with current secure policy (upgrades pre-hardening cookies)
		const isSecure =
			process.env['NODE_ENV'] === 'production' || process.env['GUI_SECURE_COOKIES'] === 'true';
		reply.setCookie(COOKIE_NAME, cookieValue, {
			path: '/gui',
			httpOnly: true,
			sameSite: 'strict',
			maxAge: COOKIE_MAX_AGE,
			signed: true,
			secure: isSecure,
		});
	});
}
