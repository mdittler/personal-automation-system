/**
 * Space management routes.
 *
 * GUI for creating, editing, and managing shared data spaces.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { SpaceService } from '../../services/spaces/index.js';
import type { UserManager } from '../../services/user-manager/index.js';

export interface SpaceRoutesOptions {
	spaceService: SpaceService;
	userManager: UserManager;
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

export function registerSpaceRoutes(server: FastifyInstance, options: SpaceRoutesOptions): void {
	const { spaceService, userManager } = options;
	const allUsers = userManager.getAllUsers();

	// --- List ---
	server.get('/spaces', async (request: FastifyRequest, reply: FastifyReply) => {
		const actor = request.user;
		// D5b-5: non-admin sees only spaces they are a member of.
		const allSpaces = spaceService.listSpaces();
		const spaces = actor && !actor.isPlatformAdmin
			? allSpaces.filter((s) => s.members.includes(actor.userId))
			: allSpaces;

		const spacesWithNames = spaces.map((s) => ({
			...s,
			memberNames: s.members.map((id) => {
				const user = userManager.getUser(id);
				return user ? user.name : id;
			}),
			creatorName: (() => {
				const user = userManager.getUser(s.createdBy);
				return user ? user.name : s.createdBy;
			})(),
		}));

		return reply.viewAsync('spaces', {
			title: 'Spaces — PAS',
			activePage: 'spaces',
			spaces: spacesWithNames,
		});
	});

	// --- New ---
	server.get('/spaces/new', async (request: FastifyRequest, reply: FastifyReply) => {
		// D5b-5: only platform-admin can create spaces.
		if (request.user && !request.user.isPlatformAdmin) {
			return reply.status(403).viewAsync('403', { title: '403 Forbidden — PAS' });
		}
		return reply.viewAsync('space-edit', {
			title: 'Create Space — PAS',
			activePage: 'spaces',
			space: null,
			users: allUsers,
			errors: [],
			isNew: true,
		});
	});

	// --- Edit ---
	server.get('/spaces/:id/edit', async (request: FastifyRequest, reply: FastifyReply) => {
		const { id } = request.params as { id: string };
		const space = spaceService.getSpace(id);
		if (!space) {
			return reply.status(404).viewAsync('spaces', {
				title: 'Spaces — PAS',
				activePage: 'spaces',
				spaces: spaceService.listSpaces(),
			});
		}

		return reply.viewAsync('space-edit', {
			title: `Edit Space — ${space.name} — PAS`,
			activePage: 'spaces',
			space,
			users: allUsers,
			errors: [],
			isNew: false,
		});
	});

	// --- Create/Update ---
	server.post('/spaces', async (request: FastifyRequest, reply: FastifyReply) => {
		const body = request.body as {
			id?: string;
			name?: string;
			description?: string;
			members?: string | string[];
			createdBy?: string;
			createdAt?: string;
			isNew?: string;
		};

		const isNew = body.isNew === 'true';

		// D5b-5: only platform-admin can create spaces.
		if (isNew && request.user && !request.user.isPlatformAdmin) {
			return reply.status(403).send('Forbidden');
		}
		const members = Array.isArray(body.members) ? body.members : body.members ? [body.members] : [];

		const def = {
			id: (body.id ?? '').trim(),
			name: (body.name ?? '').trim(),
			description: (body.description ?? '').trim(),
			members,
			createdBy: body.createdBy ?? '',
			createdAt: body.createdAt ?? new Date().toISOString(),
			kind: 'household' as const,
		};

		// For updates, preserve original creator/createdAt
		if (!isNew) {
			const existing = spaceService.getSpace(def.id);
			if (existing) {
				def.createdBy = existing.createdBy;
				def.createdAt = existing.createdAt;
			}
		}

		const errors = await spaceService.saveSpace(def);
		if (errors.length > 0) {
			return reply.viewAsync('space-edit', {
				title: isNew ? 'Create Space — PAS' : 'Edit Space — PAS',
				activePage: 'spaces',
				space: def,
				users: allUsers,
				errors,
				isNew,
			});
		}

		return reply.redirect('/gui/spaces');
	});

	// --- Delete ---
	server.post('/spaces/:id/delete', async (request: FastifyRequest, reply: FastifyReply) => {
		const { id } = request.params as { id: string };
		await spaceService.deleteSpace(id);
		return reply.redirect('/gui/spaces');
	});

	// --- Add member (htmx partial) ---
	server.post('/spaces/:id/members/add', async (request: FastifyRequest, reply: FastifyReply) => {
		const { id } = request.params as { id: string };
		const body = request.body as { userId?: string };
		const userId = body.userId?.trim();

		if (!userId) {
			return reply.status(400).type('text/html').send('Missing user ID.');
		}

		const errors = await spaceService.addMember(id, userId);
		if (errors.length > 0) {
			return reply
				.type('text/html')
				.send(
					`<p style="color:var(--pico-del-color)">${escapeHtml(errors[0]?.message ?? 'Unknown error')}</p>`,
				);
		}

		// Return updated member list
		return reply.type('text/html').send(buildMemberList(id, spaceService, userManager, allUsers));
	});

	// --- Remove member (htmx partial) ---
	server.post(
		'/spaces/:id/members/remove',
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { id } = request.params as { id: string };
			const body = request.body as { userId?: string };
			const userId = body.userId?.trim();

			if (!userId) {
				return reply.status(400).type('text/html').send('Missing user ID.');
			}

			const errors = await spaceService.removeMember(id, userId);
			if (errors.length > 0) {
				return reply
					.type('text/html')
					.send(
						`<p style="color:var(--pico-del-color)">${escapeHtml(errors[0]?.message ?? 'Unknown error')}</p>`,
					);
			}

			return reply.type('text/html').send(buildMemberList(id, spaceService, userManager, allUsers));
		},
	);
}

/** Build the htmx-replaceable member list HTML for a space. */
function buildMemberList(
	spaceId: string,
	spaceService: SpaceService,
	userManager: UserManager,
	allUsers: ReadonlyArray<{ id: string; name: string }>,
): string {
	const space = spaceService.getSpace(spaceId);
	if (!space) return '<p>Space not found.</p>';

	const memberSet = new Set(space.members);
	const nonMembers = allUsers.filter((u) => !memberSet.has(u.id));

	let html = '<ul style="list-style:none;padding:0;">';
	for (const memberId of space.members) {
		const user = userManager.getUser(memberId);
		const name = user ? escapeHtml(user.name) : escapeHtml(memberId);
		html += `<li style="display:flex;justify-content:space-between;align-items:center;padding:0.25rem 0;">`;
		html += `<span>${name}</span>`;
		html += `<form method="post" action="/gui/spaces/${escapeHtml(spaceId)}/members/remove" `;
		html += `hx-post="/gui/spaces/${escapeHtml(spaceId)}/members/remove" `;
		html += `hx-target="#member-list" hx-swap="innerHTML" style="margin:0;">`;
		html += `<input type="hidden" name="userId" value="${escapeHtml(memberId)}" />`;
		html +=
			'<button type="submit" class="outline secondary" style="padding:0.1rem 0.4rem;margin:0;font-size:0.8rem">Remove</button>';
		html += '</form></li>';
	}
	html += '</ul>';

	// Add member form
	if (nonMembers.length > 0) {
		html += `<form method="post" action="/gui/spaces/${escapeHtml(spaceId)}/members/add" `;
		html += `hx-post="/gui/spaces/${escapeHtml(spaceId)}/members/add" `;
		html += `hx-target="#member-list" hx-swap="innerHTML" `;
		html += `style="display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem;">`;
		html += `<select name="userId" style="margin:0;padding:0.2rem 0.4rem;font-size:0.85rem;">`;
		for (const u of nonMembers) {
			html += `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`;
		}
		html += '</select>';
		html +=
			'<button type="submit" class="outline" style="padding:0.2rem 0.5rem;margin:0;font-size:0.85rem">Add</button>';
		html += '</form>';
	}

	return html;
}
