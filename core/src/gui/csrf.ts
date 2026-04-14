/**
 * CSRF protection using double-submit cookie pattern.
 *
 * On authenticated GET requests, a CSRF token cookie is set.
 * POST/PUT/DELETE requests must include the token as either:
 *   - A `_csrf` field in the request body, or
 *   - An `X-CSRF-Token` header (used by htmx)
 *
 * The token is validated against the cookie value using timing-safe comparison.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const CSRF_COOKIE = 'pas_csrf';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_BODY_FIELD = '_csrf';
const CSRF_COOKIE_MAX_AGE = 24 * 60 * 60; // 24 hours

/** Generate a cryptographically random CSRF token. */
function generateCsrfToken(): string {
	return randomBytes(32).toString('hex');
}

/**
 * Extract the CSRF token from the request (body field or header).
 */
function getSubmittedToken(request: FastifyRequest): string | undefined {
	// Check header first (htmx uses this)
	const headerToken = request.headers[CSRF_HEADER];
	if (typeof headerToken === 'string' && headerToken.length > 0) {
		return headerToken;
	}

	// Check body field (regular form submissions)
	const body = request.body as Record<string, unknown> | undefined;
	if (body && typeof body[CSRF_BODY_FIELD] === 'string') {
		return body[CSRF_BODY_FIELD] as string;
	}

	return undefined;
}

/** Check if CSRF should be skipped for this URL. */
function shouldSkipCsrf(url: string): boolean {
	return url.startsWith('/gui/public/') || url === '/gui/login';
}

/**
 * Register CSRF protection on the GUI Fastify instance.
 * Must be called after auth registration (so auth cookies are set first).
 */
export async function registerCsrfProtection(server: FastifyInstance): Promise<void> {
	// Decorate request with csrfToken for use in templates
	server.decorateRequest('csrfToken', '');

	// On GET/HEAD requests, set or read the CSRF token cookie.
	// This runs in onRequest since it doesn't need the parsed body.
	server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
		if (shouldSkipCsrf(request.url)) return;

		const method = request.method.toUpperCase();
		if (method !== 'GET' && method !== 'HEAD') return;

		// Set CSRF cookie if not present, or read existing one
		let token: string | undefined;
		const existingCookie = request.cookies[CSRF_COOKIE];

		if (existingCookie) {
			const unsigned = request.unsignCookie(existingCookie);
			if (unsigned.valid && unsigned.value) {
				token = unsigned.value;
			}
		}

		if (!token) {
			token = generateCsrfToken();
		}

		// Always reissue cookie with current secure policy (upgrades pre-hardening cookies)
		const isSecure =
			process.env['NODE_ENV'] === 'production' || process.env['GUI_SECURE_COOKIES'] === 'true';
		reply.setCookie(CSRF_COOKIE, token, {
			path: '/gui',
			httpOnly: false, // Must be readable by htmx via meta tag
			sameSite: 'strict',
			maxAge: CSRF_COOKIE_MAX_AGE,
			signed: true,
			secure: isSecure,
		});

		// Make token available to templates via request decoration
		(request as unknown as Record<string, unknown>).csrfToken = token;
	});

	// On POST/PUT/DELETE, validate the CSRF token.
	// This runs in preHandler because request.body is only available
	// after Fastify's content-type parsing (which happens after onRequest).
	server.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
		if (shouldSkipCsrf(request.url)) return;

		const method = request.method.toUpperCase();

		if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
			// Validate CSRF token on state-changing requests
			const cookieRaw = request.cookies[CSRF_COOKIE];
			if (!cookieRaw) {
				return reply.status(403).send('CSRF token missing');
			}

			const unsigned = request.unsignCookie(cookieRaw);
			if (!unsigned.valid || !unsigned.value) {
				return reply.status(403).send('Invalid CSRF cookie');
			}

			const submitted = getSubmittedToken(request);
			if (!submitted) {
				return reply.status(403).send('CSRF token not provided');
			}

			// Timing-safe comparison
			const cookieBuf = Buffer.from(unsigned.value);
			const submittedBuf = Buffer.from(submitted);

			if (cookieBuf.length !== submittedBuf.length || !timingSafeEqual(cookieBuf, submittedBuf)) {
				return reply.status(403).send('CSRF token mismatch');
			}

			// Token valid — set on request for use in response partials
			(request as unknown as Record<string, unknown>).csrfToken = unsigned.value;
		}

		// Auto-inject csrfToken into all viewAsync calls so templates
		// can use it.csrfToken without modifying every route handler.
		const token = (request as unknown as Record<string, unknown>).csrfToken as string | undefined;
		if (!token) return;

		const originalViewAsync = reply.viewAsync.bind(reply);
		reply.viewAsync = (template: string, data?: Record<string, unknown>) => {
			return originalViewAsync(template, { ...data, csrfToken: token });
		};
	});
}
