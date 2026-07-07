/**
 * View-locals plugin — D5b-3.
 *
 * Registers a preHandler hook that wraps `reply.viewAsync` to automatically
 * inject the authenticated user's profile into every template render.
 *
 * Templates receive:
 *   it.currentUser  — RegisteredUser object (name, id, isAdmin) or undefined
 *   it.isPlatformAdmin — boolean shorthand
 *   it.isHouseholdAdmin — boolean shorthand
 *   it.navFlags — optional-surface availability flags (see NavFlags below)
 *
 * Merges with the CSRF token injection already applied by csrf.ts's preHandler.
 * Registration order in gui/index.ts: auth → csrf → view-locals → routes.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserManager } from '../services/user-manager/index.js';

/**
 * Feature-availability flags for nav items whose backing routes are only
 * registered when a dependency is present (see gui/index.ts's conditional
 * `registerSessionsRoutes`/`registerActivityRoutes`/`registerBackupsRoutes`
 * calls). layout.eta gates each corresponding nav link on its flag so the
 * sidebar never links to a route that 404s (final Codex review round,
 * Important).
 *
 * Defaults to all-true so call sites that don't pass `navFlags` (most
 * existing tests, which register every route unconditionally) keep the
 * pre-existing "always show the link" behavior.
 */
export interface NavFlags {
	sessions: boolean;
	activity: boolean;
	backups: boolean;
}

const DEFAULT_NAV_FLAGS: NavFlags = { sessions: true, activity: true, backups: true };

export interface ViewLocalsOptions {
	userManager: UserManager;
	/** See `NavFlags`. Defaults to all-true when omitted. */
	navFlags?: Partial<NavFlags>;
}

export async function registerViewLocals(
	server: FastifyInstance,
	options: ViewLocalsOptions,
): Promise<void> {
	const { userManager } = options;
	const navFlags: NavFlags = { ...DEFAULT_NAV_FLAGS, ...options.navFlags };

	server.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
		const actor = request.user;
		if (!actor) return;

		// Resolve the full RegisteredUser object for templates (e.g. display name)
		const currentUser = userManager.getUser(actor.userId) ?? undefined;

		const isPlatformAdmin = actor.isPlatformAdmin;
		const isHouseholdAdmin = actor.isHouseholdAdmin;

		// Wrap viewAsync to inject user locals alongside any previously-injected locals
		// (e.g. csrfToken injected by csrf.ts's preHandler, which runs before this).
		const originalViewAsync = reply.viewAsync.bind(reply);
		reply.viewAsync = (template: string, data?: Record<string, unknown>) => {
			return originalViewAsync(template, {
				currentUser,
				isPlatformAdmin,
				isHouseholdAdmin,
				navFlags,
				...data,
			});
		};
	});
}
