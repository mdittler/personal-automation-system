/**
 * User management routes.
 *
 * GUI for viewing users, managing app access, shared scopes, and removal.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { requirePlatformAdmin } from '../../gui/guards/require-platform-admin.js';
import type { AppRegistry } from '../../services/app-registry/index.js';
import type { SpaceService } from '../../services/spaces/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { UserMutationService } from '../../services/user-manager/user-mutation-service.js';
import type { SpaceDefinition } from '../../types/spaces.js';
import type { RegisteredUser } from '../../types/users.js';

export interface UserRoutesOptions {
	userManager: UserManager;
	userMutationService: UserMutationService;
	registry: AppRegistry;
	spaceService: SpaceService;
	logger: Logger;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function registerUserRoutes(server: FastifyInstance, options: UserRoutesOptions): void {
	const { userManager, userMutationService, registry, spaceService, logger } = options;

	const platformAdminOnly = { preHandler: [requirePlatformAdmin] };

	// --- List all users ---
	server.get('/users', platformAdminOnly, async (_request: FastifyRequest, reply: FastifyReply) => {
		const users = userManager.getAllUsers();
		const appIds = registry.getLoadedAppIds();
		const apps = appIds.map((id) => ({
			id,
			name: registry.getApp(id)?.manifest.app.name ?? id,
		}));
		const spaces = spaceService.listSpaces();
		const adminCount = users.filter((u) => u.isAdmin).length;

		return reply.viewAsync('users', {
			title: 'Users — PAS',
			activePage: 'users',
			users,
			apps,
			spaces,
			adminCount,
		});
	});

	// --- Update user app access (htmx partial) ---
	server.post(
		'/users/:userId/apps',
		platformAdminOnly,
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { userId } = request.params as { userId: string };

			if (!/^\d+$/.test(userId)) {
				return reply.status(400).type('text/html').send('Invalid user ID format');
			}

			const user = userManager.getUser(userId);
			if (!user) {
				return reply.status(404).type('text/html').send('User not found');
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
				return reply.status(404).type('text/html').send('User not found');
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
				return reply.status(400).type('text/html').send('Invalid user ID format');
			}

			const user = userManager.getUser(userId);
			if (!user) {
				return reply.status(404).type('text/html').send('User not found');
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
				return reply.status(400).type('text/html').send('Invalid user ID format');
			}

			const result = await userMutationService.removeUser(userId);

			if (result.error) {
				return reply
					.status(400)
					.type('text/html')
					.send(`<p style="color:var(--pico-del-color)">${escapeHtml(result.error)}</p>`);
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
