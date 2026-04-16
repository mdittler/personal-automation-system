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
 *
 * Merges with the CSRF token injection already applied by csrf.ts's preHandler.
 * Registration order in gui/index.ts: auth → csrf → view-locals → routes.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserManager } from '../services/user-manager/index.js';

export interface ViewLocalsOptions {
	userManager: UserManager;
}

export async function registerViewLocals(
	server: FastifyInstance,
	options: ViewLocalsOptions,
): Promise<void> {
	const { userManager } = options;

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
				...data,
			});
		};
	});
}
