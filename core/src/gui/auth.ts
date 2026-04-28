/**
 * GUI authentication — D5b-3.
 *
 * Replaces the single shared-token auth with per-user password login.
 * Cookie payload: { userId, sessionVersion, issuedAt, authMethod } — JSON, signed via Fastify's cookie secret.
 * The cookie is NOT the authority; every request rehydrates the actor from
 * UserManager + HouseholdService + CredentialService so revocations take effect
 * immediately on the next request.
 *
 * ## Backward compatibility
 *
 * When `credentialService`, `userManager`, and `householdService` are all absent
 * (legacy test/fallback mode), the old shared-HMAC-token behavior is preserved:
 * POST /login accepts the raw `GUI_AUTH_TOKEN` as a `token` field and sets
 * an HMAC cookie exactly as before. This keeps existing test coverage green.
 *
 * ## Legacy `GUI_AUTH_TOKEN` rule (when deps are present)
 *
 * The legacy token is still accepted when exactly ONE `isAdmin` user exists,
 * and that session maps to that admin with `authMethod: 'legacy-gui-token'`.
 * Multi-admin installs must use the username + password form.
 *
 * ## Login identifier
 *
 * Telegram user ID — unique, same as all existing data paths.
 * Display names are NOT unique and are NOT used for login.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimiter } from '../middleware/rate-limiter.js';
import { enterRequestContext } from '../services/context/request-context.js';
import type { CredentialService } from '../services/credentials/index.js';
import type { HouseholdService } from '../services/household/index.js';
import type { UserManager } from '../services/user-manager/index.js';
import type { AuthenticatedActor } from '../types/auth-actor.js';

const COOKIE_NAME = 'pas_auth';
const MAX_COOKIE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

/** Shape stored as the signed cookie value (D5b-3 new format). */
interface SessionCookiePayload {
	userId: string;
	sessionVersion: number;
	issuedAt: number; // Unix ms
	authMethod: 'gui-password' | 'legacy-gui-token';
}

export interface AuthOptions {
	/** Shared GUI auth token from config (may be empty string if not configured). */
	authToken: string;
	loginRateLimiter?: RateLimiter;
	// D5b-3 additions — optional for backward compatibility with legacy-only tests
	credentialService?: CredentialService;
	userManager?: UserManager;
	householdService?: Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSecureCookie(): boolean {
	return process.env['NODE_ENV'] === 'production' || process.env['GUI_SECURE_COOKIES'] === 'true';
}

/** Compute the legacy HMAC cookie value (pre-D5b-3 format). */
function legacyCookieValue(authToken: string): string {
	return createHmac('sha256', authToken).update('pas-gui-auth').digest('hex');
}

/** Build an `AuthenticatedActor` from a validated session — returns null if data is missing. */
function buildActor(
	userId: string,
	sessionVersion: number,
	authMethod: 'gui-password' | 'legacy-gui-token',
	householdService: Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'>,
	userManager: UserManager,
): AuthenticatedActor | null {
	const user = userManager.getUser(userId);
	if (!user) return null;

	const householdId = householdService.getHouseholdForUser(userId);
	if (!householdId) return null;

	const household = householdService.getHousehold(householdId);
	const isHouseholdAdmin = household?.adminUserIds.includes(userId) ?? false;

	return {
		userId,
		householdId,
		isPlatformAdmin: user.isAdmin,
		isHouseholdAdmin,
		authMethod,
		sessionVersion,
	};
}

/** Issue a new session cookie for a successfully authenticated user. */
export function issueSessionCookie(
	reply: FastifyReply,
	userId: string,
	sessionVersion: number,
	authMethod: 'gui-password' | 'legacy-gui-token',
): void {
	const payload: SessionCookiePayload = {
		userId,
		sessionVersion,
		issuedAt: Date.now(),
		authMethod,
	};
	reply.setCookie(COOKIE_NAME, JSON.stringify(payload), {
		path: '/gui',
		httpOnly: true,
		sameSite: 'strict',
		maxAge: COOKIE_MAX_AGE_SECONDS,
		signed: true,
		secure: isSecureCookie(),
	});
}

/** Clear the auth cookie (logout / invalidation). */
function clearSessionCookie(reply: FastifyReply): void {
	reply.clearCookie(COOKIE_NAME, { path: '/gui', secure: isSecureCookie() });
}

// ---------------------------------------------------------------------------
// Main registration
// ---------------------------------------------------------------------------

/**
 * Register auth routes and the request guard hook on the Fastify GUI instance.
 * Must be registered as a Fastify plugin within the /gui prefix.
 */
export async function registerAuth(server: FastifyInstance, options: AuthOptions): Promise<void> {
	const { authToken, credentialService, userManager, householdService, loginRateLimiter } = options;

	/** Whether D5b-3 per-user auth is available (all deps present). */
	const hasPerUserAuth = Boolean(credentialService && userManager && householdService);

	// -------------------------------------------------------------------------
	// GET /login — show the login form
	// -------------------------------------------------------------------------
	server.get('/login', async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.viewAsync('login', { title: 'Login — PAS', error: null });
	});

	// -------------------------------------------------------------------------
	// POST /login — authenticate and issue session cookie
	// -------------------------------------------------------------------------
	server.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
		const clientIp = request.ip;
		const body = request.body as Record<string, string | undefined> | undefined;

		const renderError = (error: string, status = 401) =>
			reply.status(status).viewAsync('login', { title: 'Login — PAS', error });

		// --- Legacy-only fallback (no credentialService/userManager) ---
		if (!hasPerUserAuth) {
			// Accept the raw token field (backwards-compatible with old tests + old GUI)
			if (loginRateLimiter && !loginRateLimiter.isAllowed(clientIp)) {
				return reply.status(429).viewAsync('login', {
					title: 'Login — PAS',
					error: 'Too many login attempts. Please try again later.',
				});
			}
			const submitted = body?.['token'] ?? '';
			const submittedBuf = Buffer.from(submitted);
			const expectedBuf = Buffer.from(authToken);
			const isValid =
				submittedBuf.length === expectedBuf.length && timingSafeEqual(submittedBuf, expectedBuf);
			if (!isValid) {
				return renderError('Invalid token', 200); // old tests expect 200 on wrong token
			}
			const cookieValue = legacyCookieValue(authToken);
			reply.setCookie(COOKIE_NAME, cookieValue, {
				path: '/gui',
				httpOnly: true,
				sameSite: 'strict',
				maxAge: COOKIE_MAX_AGE_SECONDS,
				signed: true,
				secure: isSecureCookie(),
			});
			return reply.redirect('/gui/');
		}

		// --- Legacy token path (D5b-3 with full deps) ---
		const legacyToken = body?.['legacyToken'];
		if (legacyToken !== undefined && legacyToken !== '') {
			if (loginRateLimiter && !loginRateLimiter.isAllowed(clientIp)) {
				return reply.status(429).viewAsync('login', {
					title: 'Login — PAS',
					error: 'Too many login attempts. Please try again later.',
				});
			}

			if (!authToken) {
				return renderError('No authentication token configured.');
			}

			const legacyBuf = Buffer.from(legacyToken);
			const expectedBuf = Buffer.from(authToken);
			const tokenValid =
				legacyBuf.length === expectedBuf.length && timingSafeEqual(legacyBuf, expectedBuf);
			if (!tokenValid) {
				return renderError('Invalid authentication token.');
			}

			// Sole-admin rule
			const admins = userManager!.getAllUsers().filter((u) => u.isAdmin);
			if (admins.length !== 1) {
				return reply.redirect(
					`/gui/login?reason=password-required&admins=${admins.length.toString()}`,
				);
			}

			const adminUser = admins[0];
			if (!adminUser) return renderError('No admin user found.');

			const sessionVersion = await credentialService!.getSessionVersion(adminUser.id);
			issueSessionCookie(reply, adminUser.id, sessionVersion, 'legacy-gui-token');
			const hasPassword = await credentialService!.hasCredentials(adminUser.id);
			return reply.redirect(hasPassword ? '/gui/' : '/gui/account');
		}

		// --- Password path ---
		const userId = body?.['userId']?.trim() ?? '';
		const password = body?.['password'] ?? '';

		if (!userId || !password) {
			return renderError('User ID and password are required.');
		}

		// Rate-limit by IP and by userId
		if (loginRateLimiter && !loginRateLimiter.isAllowed(clientIp)) {
			return reply.status(429).viewAsync('login', {
				title: 'Login — PAS',
				error: 'Too many login attempts. Please try again later.',
			});
		}
		if (loginRateLimiter && !loginRateLimiter.isAllowed(`user:${userId}`)) {
			return reply.status(429).viewAsync('login', {
				title: 'Login — PAS',
				error: 'Too many login attempts for this user. Please try again later.',
			});
		}

		// Verify user exists — same error as wrong password to prevent enumeration
		const user = userManager!.getUser(userId);
		if (!user) {
			return renderError('Invalid user ID or password.');
		}

		const valid = await credentialService!.verifyPassword(userId, password);
		if (!valid) {
			return renderError('Invalid user ID or password.');
		}

		const sessionVersion = await credentialService!.getSessionVersion(userId);
		issueSessionCookie(reply, userId, sessionVersion, 'gui-password');
		return reply.redirect('/gui/');
	});

	// -------------------------------------------------------------------------
	// POST /logout — clear cookies and redirect to login
	// -------------------------------------------------------------------------
	server.post('/logout', async (_request: FastifyRequest, reply: FastifyReply) => {
		clearSessionCookie(reply);
		reply.clearCookie('pas_csrf', { path: '/gui', secure: isSecureCookie() });
		return reply.redirect('/gui/login');
	});

	// -------------------------------------------------------------------------
	// onRequest guard — validates the session cookie on every /gui/* request
	// -------------------------------------------------------------------------
	server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
		const url = request.url;

		// Skip auth for login page and static assets
		if (url === '/gui/login' || url.startsWith('/gui/login?') || url.startsWith('/gui/public/')) {
			return;
		}

		// ------------------------------------------------------------------
		// 1. Read and unsign the cookie
		// ------------------------------------------------------------------
		const rawCookie = request.cookies[COOKIE_NAME];
		if (!rawCookie) {
			return reply.redirect('/gui/login');
		}

		const unsigned = request.unsignCookie(rawCookie);
		if (!unsigned.valid || !unsigned.value) {
			clearSessionCookie(reply);
			return reply.redirect('/gui/login');
		}

		const cookieValue = unsigned.value;

		// ------------------------------------------------------------------
		// 2. Legacy-only fallback (no per-user deps)
		// ------------------------------------------------------------------
		if (!hasPerUserAuth) {
			const expected = legacyCookieValue(authToken);
			if (cookieValue !== expected) {
				clearSessionCookie(reply);
				return reply.redirect('/gui/login');
			}
			// Reissue with current secure policy (sliding session / policy upgrade)
			reply.setCookie(COOKIE_NAME, cookieValue, {
				path: '/gui',
				httpOnly: true,
				sameSite: 'strict',
				maxAge: COOKIE_MAX_AGE_SECONDS,
				signed: true,
				secure: isSecureCookie(),
			});
			return;
		}

		// ------------------------------------------------------------------
		// 3. Legacy cookie fallback (per-user deps present, but cookie is old HMAC format)
		// ------------------------------------------------------------------
		if (authToken && cookieValue === legacyCookieValue(authToken)) {
			const admins = userManager!.getAllUsers().filter((u) => u.isAdmin);
			if (admins.length !== 1) {
				clearSessionCookie(reply);
				return reply.redirect('/gui/login?reason=password-required');
			}

			const adminUser = admins[0];
			if (!adminUser) {
				clearSessionCookie(reply);
				return reply.redirect('/gui/login');
			}

			const sessionVersion = await credentialService!.getSessionVersion(adminUser.id);
			const actor = buildActor(
				adminUser.id,
				sessionVersion,
				'legacy-gui-token',
				householdService!,
				userManager!,
			);
			if (!actor) {
				clearSessionCookie(reply);
				return reply.redirect('/gui/login');
			}

			request.user = actor;
			enterRequestContext({ userId: actor.userId, householdId: actor.householdId });
			// Upgrade to new-format cookie
			issueSessionCookie(reply, adminUser.id, sessionVersion, 'legacy-gui-token');
			return;
		}

		// ------------------------------------------------------------------
		// 4. New JSON cookie format (D5b-3)
		// ------------------------------------------------------------------
		let payload: SessionCookiePayload;
		try {
			payload = JSON.parse(cookieValue) as SessionCookiePayload;
		} catch {
			clearSessionCookie(reply);
			return reply.redirect('/gui/login');
		}

		// 4a. Check expiry (sliding session)
		if (!payload.issuedAt || Date.now() - payload.issuedAt > MAX_COOKIE_AGE_MS) {
			clearSessionCookie(reply);
			return reply.redirect('/gui/login?reason=expired');
		}

		// 4b. Look up user
		const user = userManager!.getUser(payload.userId);
		if (!user) {
			clearSessionCookie(reply);
			return reply.redirect('/gui/login?reason=user-removed');
		}

		// 4c. Validate session version
		// sessionVersion 0 means the user has never set a password — accept legacy-promoted sessions
		const currentVersion = await credentialService!.getSessionVersion(payload.userId);
		if (currentVersion !== 0 && payload.sessionVersion !== currentVersion) {
			clearSessionCookie(reply);
			return reply.redirect('/gui/login?reason=session-invalidated');
		}

		// 4d. Build actor
		const actor = buildActor(
			payload.userId,
			currentVersion,
			payload.authMethod ?? 'gui-password',
			householdService!,
			userManager!,
		);
		if (!actor) {
			clearSessionCookie(reply);
			return reply.redirect('/gui/login?reason=household-missing');
		}

		// 4e. Populate request.user and ALS context
		request.user = actor;
		enterRequestContext({ userId: actor.userId, householdId: actor.householdId });

		// 4f. Reissue cookie with fresh issuedAt (sliding session)
		issueSessionCookie(
			reply,
			actor.userId,
			currentVersion,
			actor.authMethod as 'gui-password' | 'legacy-gui-token',
		);
	});
}
