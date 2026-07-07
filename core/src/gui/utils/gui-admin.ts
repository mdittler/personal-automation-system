/**
 * Shared "is this GUI request an admin?" resolution (final Codex review
 * round, Important).
 *
 * `request.user` is `undefined` for the entire request in the fully
 * legacy-only auth mode — when `registerAuth` is given ONLY `{ authToken }`
 * with no `credentialService`/`userManager`/`householdService` (see
 * auth.ts's `hasPerUserAuth` branch). That mode has no per-user model at
 * all: a single shared token IS the admin session. The rest of the GUI
 * already treats a missing `request.user` as an unrestricted/admin actor —
 * see report-wizard.ts's and alert-wizard.ts's own `isPlatformAdmin(request)`
 * helper (`!request.user || request.user.isPlatformAdmin`), and the
 * `if (request.user && !request.user.isPlatformAdmin)` guard repeated across
 * reports.ts/alerts.ts/data.ts/spaces.ts. This helper does not invent new
 * semantics — it copies that existing convention into one shared place so
 * routes that compute an `isAdmin` boolean for VIEW SCOPING (as opposed to a
 * hard 403 gate) stop treating "no request.user" as "definitely not admin".
 *
 * Do NOT use this for hard route guards (that's `requirePlatformAdmin`,
 * which correctly 403s an unauthenticated request) — this is for routes like
 * dashboard.ts/metrics.ts that compute a soft `isAdmin` flag to decide
 * between an admin view and a member-scoped view, where legacy-only mode
 * should resolve to the admin view rather than an incorrectly-scoped empty
 * member view.
 */
import type { FastifyRequest } from 'fastify';

export function isGuiAdmin(request: Pick<FastifyRequest, 'user'>): boolean {
	return !request.user || request.user.isPlatformAdmin;
}
