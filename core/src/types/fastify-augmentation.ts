/**
 * Fastify module augmentation — adds actor fields to FastifyRequest.
 *
 * This file has no runtime exports. Import it once as a side-effect (in bootstrap.ts)
 * so the declaration merging takes effect across the entire process.
 *
 * - `request.user`  — set by the GUI auth guard (D5b-3) for every authenticated GUI request.
 * - `request.actor` — set by the API auth hook (D5b-6) for every authenticated API request.
 *
 * Using two distinct field names avoids confusion between GUI sessions (cookie-based,
 * sliding expiry) and API actors (token-based, scope-gated).
 */
import type { AuthenticatedActor } from './auth-actor.js';

declare module 'fastify' {
	interface FastifyRequest {
		/** Populated by the GUI auth guard on every authenticated GUI request. */
		user?: AuthenticatedActor;
		/** Populated by the API auth hook on every authenticated API request. */
		actor?: AuthenticatedActor;
	}
}
