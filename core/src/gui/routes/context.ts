/**
 * Context management routes.
 *
 * GET /gui/context — main context page with per-user sections
 * GET /gui/context/:userId — htmx partial: list entries for a user
 * GET /gui/context/:userId/edit?key= — htmx partial: edit form
 * POST /gui/context/:userId — save entry
 * POST /gui/context/:userId/delete — delete entry
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { requirePlatformAdmin } from '../../gui/guards/require-platform-admin.js';
import type { ContextStoreServiceImpl } from '../../services/context-store/index.js';
import { requestContext } from '../../services/context/request-context.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { SystemConfig } from '../../types/config.js';

export interface ContextRoutesOptions {
	contextStore: ContextStoreServiceImpl;
	config: SystemConfig;
	logger: Logger;
	householdService: Pick<HouseholdService, 'getHouseholdForUser'>;
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function registerContextRoutes(
	server: FastifyInstance,
	options: ContextRoutesOptions,
): void {
	const { contextStore, config, logger, householdService } = options;

	const buildCtx = (userId: string) => ({
		userId,
		householdId: householdService.getHouseholdForUser(userId) ?? undefined,
	});

	const platformAdminOnly = { preHandler: [requirePlatformAdmin] };

	// Main page
	server.get(
		'/context',
		platformAdminOnly,
		async (_request: FastifyRequest, reply: FastifyReply) => {
			return reply.viewAsync('context', {
				title: 'Context — PAS',
				activePage: 'context',
				users: config.users,
			});
		},
	);

	// htmx partial: list entries for a user
	server.get<{ Params: { userId: string } }>(
		'/context/:userId',
		platformAdminOnly,
		async (request, reply) => {
			const { userId } = request.params;
			if (!SAFE_ID.test(userId)) {
				return reply.status(400).type('text/html').send('Invalid user ID');
			}

			const entries = await requestContext.run(buildCtx(userId), () =>
				contextStore.listForUser(userId),
			);
			const csrfToken = (request as unknown as Record<string, unknown>).csrfToken as string;
			const safeUserId = escapeHtml(userId);

			let html = '';

			if (entries.length === 0) {
				html += '<p><em>No context entries yet.</em></p>';
			} else {
				html +=
					'<table><thead><tr><th>Key</th><th>Preview</th><th>Modified</th><th></th></tr></thead><tbody>';
				for (const entry of entries) {
					const safeKey = escapeHtml(entry.key);
					const preview = escapeHtml(entry.content.slice(0, 80).replace(/\n/g, ' '));
					const modified = entry.lastUpdated.toISOString().split('T')[0];
					html += '<tr>';
					html += `<td><code>${safeKey}</code></td>`;
					html += `<td>${preview}${entry.content.length > 80 ? '...' : ''}</td>`;
					html += `<td>${modified}</td>`;
					html += `<td style="white-space:nowrap">`;
					html += `<button class="outline" style="padding:0.25rem 0.5rem;margin:0 0.25rem 0 0;font-size:0.8rem" hx-get="/gui/context/${safeUserId}/edit?key=${safeKey}" hx-target="#form-${safeUserId}" hx-swap="innerHTML">Edit</button>`;
					html += `<form method="post" action="/gui/context/${safeUserId}/delete" style="display:inline;margin:0">`;
					if (csrfToken)
						html += `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />`;
					html += `<input type="hidden" name="key" value="${safeKey}" />`;
					html += `<button type="submit" class="outline secondary" style="padding:0.25rem 0.5rem;margin:0;font-size:0.8rem" data-confirm-delete="Delete ${safeKey}?">Delete</button>`;
					html += '</form>';
					html += '</td>';
					html += '</tr>';
				}
				html += '</tbody></table>';
			}

			html += `<button class="outline" style="margin-top:0.5rem" hx-get="/gui/context/${safeUserId}/edit?key=" hx-target="#form-${safeUserId}" hx-swap="innerHTML">+ Add Entry</button>`;
			html += `<div id="form-${safeUserId}" style="margin-top:1rem"></div>`;

			return reply.type('text/html').send(html);
		},
	);

	// htmx partial: edit/create form
	server.get<{ Params: { userId: string }; Querystring: { key?: string } }>(
		'/context/:userId/edit',
		platformAdminOnly,
		async (request, reply) => {
			const { userId } = request.params;
			const key = (request.query as { key?: string }).key ?? '';
			if (!SAFE_ID.test(userId)) {
				return reply.status(400).type('text/html').send('Invalid user ID');
			}

			const csrfToken = (request as unknown as Record<string, unknown>).csrfToken as string;
			const safeUserId = escapeHtml(userId);
			const isEdit = key.length > 0;

			let content = '';
			if (isEdit) {
				const existing = await requestContext.run(buildCtx(userId), () =>
					contextStore.getForUser(key, userId),
				);
				content = existing ?? '';
			}

			let html = `<form method="post" action="/gui/context/${safeUserId}">`;
			if (csrfToken)
				html += `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />`;

			if (isEdit) {
				html += `<input type="hidden" name="key" value="${escapeHtml(key)}" />`;
				html += `<label>Name: <code>${escapeHtml(key)}</code></label>`;
			} else {
				html += `<label for="ctx-key-${safeUserId}">Name</label>`;
				html += `<input type="text" id="ctx-key-${safeUserId}" name="key" required maxlength="100" placeholder="e.g., Food Preferences" />`;
			}

			html += `<label for="ctx-content-${safeUserId}">Content <small>(markdown)</small></label>`;
			html += `<textarea id="ctx-content-${safeUserId}" name="content" rows="6" required>${escapeHtml(content)}</textarea>`;
			html += `<div style="display:flex;gap:0.5rem">`;
			html += `<button type="submit">${isEdit ? 'Update' : 'Create'}</button>`;
			html += `<button type="button" class="outline secondary" onclick="this.closest('form').parentElement.innerHTML=''">Cancel</button>`;
			html += '</div>';
			html += '</form>';

			return reply.type('text/html').send(html);
		},
	);

	// Save entry
	server.post<{ Params: { userId: string } }>(
		'/context/:userId',
		platformAdminOnly,
		async (request, reply) => {
			const { userId } = request.params;
			const body = request.body as Record<string, string>;

			if (!SAFE_ID.test(userId)) {
				return reply.status(400).send('Invalid user ID');
			}
			if (!config.users.some((u) => u.id === userId)) {
				return reply.status(400).send('User not found');
			}

			const key = body.key?.trim();
			const content = body.content?.trim();

			if (!key || !content) {
				return reply.status(400).send('Name and content are required');
			}

			try {
				await requestContext.run(buildCtx(userId), () => contextStore.save(userId, key, content));
				logger.info({ userId, key }, 'Context entry saved via GUI');
			} catch (err) {
				logger.error({ userId, key, error: err }, 'Failed to save context entry');
				return reply
					.status(400)
					.type('text/html')
					.send(escapeHtml(err instanceof Error ? err.message : 'Failed to save'));
			}

			return reply.redirect('/gui/context');
		},
	);

	// Delete entry
	server.post<{ Params: { userId: string } }>(
		'/context/:userId/delete',
		platformAdminOnly,
		async (request, reply) => {
			const { userId } = request.params;
			const body = request.body as Record<string, string>;

			if (!SAFE_ID.test(userId)) {
				return reply.status(400).send('Invalid user ID');
			}

			const key = body.key?.trim();
			if (!key) {
				return reply.status(400).send('Key is required');
			}

			try {
				await requestContext.run(buildCtx(userId), () => contextStore.remove(userId, key));
				logger.info({ userId, key }, 'Context entry deleted via GUI');
			} catch (err) {
				logger.error({ userId, key, error: err }, 'Failed to delete context entry');
				return reply.status(500).send('Failed to delete');
			}

			return reply.redirect('/gui/context');
		},
	);
}
