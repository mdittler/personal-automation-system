/**
 * User management routes.
 *
 * GUI for viewing users, managing app access, shared scopes, and removal.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppRegistry } from '../../services/app-registry/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { UserMutationService } from '../../services/user-manager/user-mutation-service.js';
import type { RegisteredUser } from '../../types/users.js';

export interface UserRoutesOptions {
	userManager: UserManager;
	userMutationService: UserMutationService;
	registry: AppRegistry;
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
	const { userManager, userMutationService, registry, logger } = options;

	// --- List all users ---
	server.get('/users', async (_request: FastifyRequest, reply: FastifyReply) => {
		const users = userManager.getAllUsers();
		const appIds = registry.getLoadedAppIds();
		const apps = appIds.map((id) => ({
			id,
			name: registry.getApp(id)?.manifest.app.name ?? id,
		}));

		return reply.viewAsync('users', {
			title: 'Users — PAS',
			activePage: 'users',
			users,
			apps,
		});
	});

	// --- Update user app access (htmx partial) ---
	server.post('/users/:userId/apps', async (request: FastifyRequest, reply: FastifyReply) => {
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

		return reply
			.type('text/html')
			.send(buildUserRow(updatedUser, allAppIds, registry, userManager));
	});

	// --- Update user shared scopes (htmx partial) ---
	server.post('/users/:userId/groups', async (request: FastifyRequest, reply: FastifyReply) => {
		const { userId } = request.params as { userId: string };

		if (!/^\d+$/.test(userId)) {
			return reply.status(400).type('text/html').send('Invalid user ID format');
		}

		const user = userManager.getUser(userId);
		if (!user) {
			return reply.status(404).type('text/html').send('User not found');
		}

		const body = request.body as { groups?: string };
		const raw = (body.groups ?? '').trim();
		const groups = raw
			? raw
					.split(',')
					.map((g) => g.trim())
					.filter(Boolean)
			: [];

		// Validate each group name
		for (const group of groups) {
			if (!/^[a-zA-Z0-9_-]+$/.test(group)) {
				return reply
					.status(400)
					.type('text/html')
					.send(
						`<p style="color:var(--pico-del-color)">Invalid group name: ${escapeHtml(group)}</p>`,
					);
			}
		}

		await userMutationService.updateUserSharedScopes(userId, groups);
		logger.info({ userId, groups }, 'User shared scopes updated via GUI');

		return reply.type('text/html').send(buildGroupsCell(userId, groups));
	});

	// --- Remove user (htmx partial) ---
	server.post('/users/:userId/remove', async (request: FastifyRequest, reply: FastifyReply) => {
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
	});
}

/** Build a full <tr> for a user row (htmx-replaceable). */
function buildUserRow(
	user: RegisteredUser,
	allAppIds: string[],
	registry: AppRegistry,
	_userManager: UserManager,
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

	// Groups cell
	html += `<td id="groups-${safeId}">`;
	html += buildGroupsCell(user.id, user.sharedScopes);
	html += '</td>';

	// Remove button cell
	html += '<td>';
	html += `<button class="outline secondary" style="padding:0.25rem 0.5rem;margin:0;font-size:0.8rem" `;
	html += `hx-post="/gui/users/${safeId}/remove" `;
	html += `hx-target="#user-row-${safeId}" hx-swap="delete" `;
	html += `hx-confirm="Remove user ${safeName}?">Remove</button>`;
	html += '</td>';

	html += '</tr>';
	return html;
}

/** Build the groups form cell content (htmx-replaceable). */
function buildGroupsCell(userId: string, groups: string[]): string {
	const safeId = escapeHtml(userId);
	const groupsValue = escapeHtml(groups.join(', '));

	let html = `<form method="post" action="/gui/users/${safeId}/groups" `;
	html += `hx-post="/gui/users/${safeId}/groups" `;
	html += `hx-target="#groups-${safeId}" hx-swap="innerHTML" `;
	html += `style="display:flex;gap:0.25rem;align-items:center;margin:0;">`;
	html += `<input type="text" name="groups" value="${groupsValue}" `;
	html += `placeholder="scope1, scope2" style="margin:0;padding:0.2rem 0.4rem;font-size:0.85rem;" />`;
	html += `<button type="submit" class="outline" style="padding:0.2rem 0.5rem;margin:0;font-size:0.85rem">Save</button>`;
	html += '</form>';

	return html;
}
