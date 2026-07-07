/**
 * Household hub routes (Batch 5, Tasks 5.1 + 5.2).
 *
 * GUI for viewing household members, managing app access, shared scopes,
 * removal, and inviting new members (admin). Task 5.2 deliberately opens
 * `GET /users` to any authenticated user: platform admins see the full
 * management view (all users, invite form, mutation controls); members see
 * a read-only view scoped to their OWN household only. All mutation POSTs
 * (apps, groups, remove, invite) remain platform-admin-only.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { requirePlatformAdmin } from '../../gui/guards/require-platform-admin.js';
import type { AppRegistry } from '../../services/app-registry/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { InviteService } from '../../services/invite/index.js';
import type { SpaceService } from '../../services/spaces/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { UserMutationService } from '../../services/user-manager/user-mutation-service.js';
import type { SpaceDefinition } from '../../types/spaces.js';
import type { RegisteredUser } from '../../types/users.js';
import { sendErrorFragment } from '../utils/error-fragment.js';
import { humanizeLabel } from '../utils/humanize.js';

export interface UserRoutesOptions {
	userManager: UserManager;
	userMutationService: UserMutationService;
	registry: AppRegistry;
	spaceService: SpaceService;
	logger: Logger;
	/**
	 * Required for the Task 5.2 member-scoped read-only view and the Task 5.1
	 * invite flow's household resolution. Optional only for legacy test
	 * harnesses that never exercise the member branch or invite POST.
	 */
	householdService?: Pick<
		HouseholdService,
		'getHouseholdForUser' | 'listHouseholds' | 'getHousehold' | 'getMembers'
	>;
	/** Required for the invite flow (Task 5.1). Optional for legacy test harnesses. */
	inviteService?: InviteService;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Build the friendly app-label list for a user (mirrors the enabledApps → label mapping in users.ts's row builder). */
function friendlyAppLabels(
	user: Pick<RegisteredUser, 'enabledApps'>,
	registry: AppRegistry,
): string[] {
	if (user.enabledApps.includes('*')) {
		return registry.getLoadedAppIds().map((id) => registry.getApp(id)?.manifest.app.name ?? id);
	}
	return user.enabledApps.map((id) => registry.getApp(id)?.manifest.app.name ?? id);
}

export function registerUserRoutes(server: FastifyInstance, options: UserRoutesOptions): void {
	const {
		userManager,
		userMutationService,
		registry,
		spaceService,
		logger,
		householdService,
		inviteService,
	} = options;

	const platformAdminOnly = { preHandler: [requirePlatformAdmin] };

	// --- Household hub: admin sees full management view, member sees read-only own-household view ---
	server.get('/users', async (request: FastifyRequest, reply: FastifyReply) => {
		const actor = request.user;
		if (!actor) {
			return reply.status(403).viewAsync('403', { title: '403 Forbidden — PAS' });
		}

		if (actor.isPlatformAdmin) {
			const users = userManager.getAllUsers();
			const appIds = registry.getLoadedAppIds();
			const apps = appIds.map((id) => ({
				id,
				name: registry.getApp(id)?.manifest.app.name ?? id,
			}));
			const spaces = spaceService.listSpaces();
			const adminCount = users.filter((u) => u.isAdmin).length;

			const households = householdService?.listHouseholds() ?? [];
			const invites = inviteService ? await inviteService.listInvites() : {};
			const pendingInvites = Object.entries(invites)
				.filter(([, invite]) => invite.usedBy === null)
				.map(([code, invite]) => ({
					code,
					name: invite.name,
					role: humanizeLabel(invite.role),
					expiresAt: invite.expiresAt,
					expired: new Date(invite.expiresAt) <= new Date(),
				}));

			return reply.viewAsync('household', {
				title: 'Household — PAS',
				activePage: 'users',
				isReadOnly: false,
				users: users.map((u) => ({
					...u,
					roleLabel: humanizeLabel(u.isAdmin ? 'admin' : 'member'),
					appLabels: friendlyAppLabels(u, registry),
				})),
				apps,
				spaces,
				adminCount,
				households,
				pendingInvites,
			});
		}

		// --- Member: read-only view of their OWN household only ---
		if (!householdService) {
			return reply.status(403).viewAsync('403', { title: '403 Forbidden — PAS' });
		}
		const hhId = householdService.getHouseholdForUser(actor.userId);
		const members = hhId ? householdService.getMembers(hhId) : [];
		const household = hhId ? householdService.getHousehold(hhId) : null;

		return reply.viewAsync('household', {
			title: 'Household — PAS',
			activePage: 'users',
			isReadOnly: true,
			household,
			users: members.map((u) => ({
				...u,
				roleLabel: humanizeLabel(u.isAdmin ? 'admin' : 'member'),
				appLabels: friendlyAppLabels(u, registry),
			})),
		});
	});

	// --- Create invite (admin) ---
	server.post(
		'/users/invite',
		platformAdminOnly,
		async (request: FastifyRequest, reply: FastifyReply) => {
			if (!inviteService) {
				return sendErrorFragment(reply, 500, 'Invites are not configured on this system.');
			}
			const actor = request.user;
			if (!actor) {
				return sendErrorFragment(reply, 403, "You don't have permission to do that.");
			}

			const body = request.body as { name?: string; role?: string; householdId?: string };
			const name = (body.name ?? '').trim();
			if (!name) {
				return sendErrorFragment(reply, 400, 'A name is required to create an invite.');
			}

			const role = body.role === 'admin' ? 'admin' : 'member';

			// Resolve the household: an explicit picker value (platform admin, multiple
			// households) takes precedence; otherwise default to the admin's own household.
			const resolvedHouseholdId =
				(body.householdId?.trim() || undefined) ??
				householdService?.getHouseholdForUser(actor.userId) ??
				undefined;

			if (!resolvedHouseholdId) {
				return sendErrorFragment(
					reply,
					400,
					"We couldn't figure out which household to add them to. Ask a system administrator to check the household setup.",
				);
			}

			let code: string;
			try {
				code = await inviteService.createInvite(name, actor.userId, {
					householdId: resolvedHouseholdId,
					role,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Could not create the invite.';
				return sendErrorFragment(reply, 400, message);
			}

			logger.info({ name, role, householdId: resolvedHouseholdId }, 'Invite created via GUI');

			const safeName = escapeHtml(name);
			const safeCode = escapeHtml(code);
			return reply.type('text/html').send(
				`<div class="pas-invite-card" role="status">
					<p>Invite created for <strong>${safeName}</strong>.</p>
					<p>Send this to them in Telegram: <code>/start ${safeCode}</code></p>
					<p><small>Expires in 24 hours.</small></p>
					<p><small>Then set their password below (optional) — once they've registered, use <a href="/gui/users">Reset Password</a> on their row.</small></p>
				</div>`,
			);
		},
	);

	// --- Update user app access (htmx partial) ---
	server.post(
		'/users/:userId/apps',
		platformAdminOnly,
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { userId } = request.params as { userId: string };

			if (!/^\d+$/.test(userId)) {
				return sendErrorFragment(reply, 400, "That user ID isn't valid.");
			}

			const user = userManager.getUser(userId);
			if (!user) {
				return sendErrorFragment(reply, 404, "That user couldn't be found.");
			}

			const body = request.body as Record<string, string>;
			const allAppIds = registry.getLoadedAppIds();
			const checkedApps: string[] = [];

			for (const appId of allAppIds) {
				if (body[`app_${appId}`] === 'on') {
					checkedApps.push(appId);
				}
			}

			const finalApps = checkedApps.length === allAppIds.length ? ['*'] : checkedApps;

			await userMutationService.updateUserApps(userId, finalApps);
			logger.info({ userId, apps: finalApps }, 'User apps updated via GUI');

			// Re-fetch user after mutation
			const updatedUser = userManager.getUser(userId);
			if (!updatedUser) {
				return sendErrorFragment(reply, 404, "That user couldn't be found.");
			}

			const spaces = spaceService.listSpaces();
			const adminCount = userManager.getAllUsers().filter((u) => u.isAdmin).length;
			return reply
				.type('text/html')
				.send(buildUserRow(updatedUser, allAppIds, registry, spaces, adminCount));
		},
	);

	// --- Update user shared scopes via space checkboxes (htmx partial) ---
	server.post(
		'/users/:userId/groups',
		platformAdminOnly,
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { userId } = request.params as { userId: string };

			if (!/^\d+$/.test(userId)) {
				return sendErrorFragment(reply, 400, "That user ID isn't valid.");
			}

			const user = userManager.getUser(userId);
			if (!user) {
				return sendErrorFragment(reply, 404, "That user couldn't be found.");
			}

			const body = request.body as Record<string, string>;
			const allSpaces = spaceService.listSpaces();
			const checkedScopes: string[] = [];

			for (const space of allSpaces) {
				if (body[`space_${space.id}`] === 'on') {
					checkedScopes.push(space.id);
				}
			}

			await userMutationService.updateUserSharedScopes(userId, checkedScopes);
			logger.info({ userId, scopes: checkedScopes }, 'User shared scopes updated via GUI');

			return reply.type('text/html').send(buildSpacesCell(userId, checkedScopes, allSpaces));
		},
	);

	// --- Remove user (htmx partial) ---
	server.post(
		'/users/:userId/remove',
		platformAdminOnly,
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { userId } = request.params as { userId: string };

			if (!/^\d+$/.test(userId)) {
				return sendErrorFragment(reply, 400, "That user ID isn't valid.");
			}

			const result = await userMutationService.removeUser(userId);

			if (result.error) {
				return sendErrorFragment(reply, 400, result.error);
			}

			logger.info({ userId }, 'User removed via GUI');

			// Return empty string — htmx hx-swap="delete" removes the row
			return reply.type('text/html').send('');
		},
	);
}

/** Build a full <tr> for a user row (htmx-replaceable). */
function buildUserRow(
	user: RegisteredUser,
	allAppIds: string[],
	registry: AppRegistry,
	spaces: SpaceDefinition[],
	adminCount: number,
): string {
	const safeName = escapeHtml(user.name);
	const safeId = escapeHtml(user.id);
	const adminBadge = user.isAdmin ? ' <small>(admin)</small>' : '';

	// Determine which apps are effectively enabled
	const hasWildcard = user.enabledApps.includes('*');
	const enabledSet = new Set(user.enabledApps);

	let html = `<tr id="user-row-${safeId}">`;

	// Name cell
	html += `<td>${safeName}${adminBadge}<br><small>${safeId}</small></td>`;

	// App checkboxes cell
	html += '<td>';
	html += `<form method="post" action="/gui/users/${safeId}/apps" `;
	html += `hx-post="/gui/users/${safeId}/apps" `;
	html += `hx-target="#user-row-${safeId}" hx-swap="outerHTML">`;
	for (const appId of allAppIds) {
		const safeAppId = escapeHtml(appId);
		const appName = registry.getApp(appId)?.manifest.app.name ?? appId;
		const safeAppName = escapeHtml(appName);
		const checked = hasWildcard || enabledSet.has(appId) ? ' checked' : '';
		html += `<label style="display:inline-flex;align-items:center;gap:0.25rem;margin-right:0.75rem;font-size:0.85rem;">`;
		html += `<input type="checkbox" name="app_${safeAppId}" onchange="this.form.requestSubmit()"${checked} style="margin:0;" />`;
		html += `${safeAppName}`;
		html += '</label>';
	}
	html += '</form>';
	html += '</td>';

	// Spaces checkboxes cell
	html += `<td id="groups-${safeId}">`;
	html += buildSpacesCell(user.id, user.sharedScopes ?? [], spaces);
	html += '</td>';

	// Remove button cell — disabled for sole admin
	const isSoleAdmin = user.isAdmin && adminCount <= 1;
	html += '<td>';
	html += `<a href="/gui/users/${safeId}/reset-password" role="button" class="outline secondary" style="padding:0.25rem 0.5rem;margin:0;font-size:0.8rem">Reset Password</a>`;
	if (isSoleAdmin) {
		html += `<button class="outline secondary" style="padding:0.25rem 0.5rem;margin:0 0 0 0.35rem;font-size:0.8rem;opacity:0.4;cursor:not-allowed" disabled title="Cannot remove the sole admin">Remove</button>`;
	} else {
		html += `<button class="outline secondary" style="padding:0.25rem 0.5rem;margin:0 0 0 0.35rem;font-size:0.8rem" `;
		html += `hx-post="/gui/users/${safeId}/remove" `;
		html += `hx-target="#user-row-${safeId}" hx-swap="delete" `;
		html += `hx-confirm="Remove user ${safeName}?">Remove</button>`;
	}
	html += '</td>';

	html += '</tr>';
	return html;
}

/** Build the spaces checkboxes cell content (htmx-replaceable). */
function buildSpacesCell(userId: string, userScopes: string[], spaces: SpaceDefinition[]): string {
	const safeId = escapeHtml(userId);
	const scopeSet = new Set(userScopes);

	if (spaces.length === 0) {
		return `<span style="font-size:0.85rem;color:var(--pas-text-muted)">No spaces — <a href="/gui/spaces">create one</a></span>`;
	}

	let html = `<form method="post" action="/gui/users/${safeId}/groups" `;
	html += `hx-post="/gui/users/${safeId}/groups" `;
	html += `hx-target="#groups-${safeId}" hx-swap="innerHTML" `;
	html += `style="margin:0;">`;

	for (const space of spaces) {
		const safeSpaceId = escapeHtml(space.id);
		const safeSpaceName = escapeHtml(space.name);
		const checked = scopeSet.has(space.id) ? ' checked' : '';
		html += `<label style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.25rem;font-weight:normal;font-size:0.85rem;">`;
		html += `<input type="checkbox" name="space_${safeSpaceId}" onchange="this.form.requestSubmit()"${checked} style="margin:0;" />`;
		html += `${safeSpaceName}`;
		html += '</label>';
	}

	html += '</form>';
	return html;
}
