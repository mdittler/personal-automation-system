/**
 * Apps route.
 *
 * GET /gui/apps — list all registered apps with enable/disable toggles.
 * POST /gui/apps/:appId/toggle — toggle app enabled state for a user.
 * GET /gui/apps/:appId — app detail page with manifest info.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { requirePlatformAdmin } from '../../gui/guards/require-platform-admin.js';
import type { AppRegistry } from '../../services/app-registry/index.js';
import type { AppToggleStore } from '../../services/app-toggle/index.js';
import { AppConfigServiceImpl } from '../../services/config/app-config-service.js';
import type { SystemConfig } from '../../types/config.js';
import type { ManifestUserConfig } from '../../types/manifest.js';

export interface AppsOptions {
	registry: AppRegistry;
	config: SystemConfig;
	appToggle: AppToggleStore;
	dataDir: string;
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

export function registerAppsRoutes(server: FastifyInstance, options: AppsOptions): void {
	const { registry, config, appToggle, dataDir, logger } = options;

	// D5b-4: platform-admin gate
	server.addHook('preHandler', requirePlatformAdmin);

	// Cache AppConfigServiceImpl instances per appId
	const configServiceCache = new Map<string, AppConfigServiceImpl>();

	function getAppConfigService(
		appId: string,
		defaults: ManifestUserConfig[],
	): AppConfigServiceImpl {
		let service = configServiceCache.get(appId);
		if (!service) {
			service = new AppConfigServiceImpl({ dataDir, appId, defaults });
			configServiceCache.set(appId, service);
		}
		return service;
	}

	// App list
	server.get('/apps', async (_request: FastifyRequest, reply: FastifyReply) => {
		const apps = registry.getAll();
		const users = config.users;
		const overrides = await appToggle.getAllOverrides();

		// Build app status per user
		const appList = await Promise.all(
			apps.map(async (app) => {
				const appId = app.manifest.app.id;
				const userStatuses = await Promise.all(
					users.map(async (user) => ({
						userId: user.id,
						userName: user.name,
						enabled: await appToggle.isEnabled(user.id, appId, user.enabledApps),
						hasOverride: overrides[user.id]?.[appId] !== undefined,
					})),
				);

				return {
					id: appId,
					name: app.manifest.app.name,
					version: app.manifest.app.version,
					description: app.manifest.app.description,
					userStatuses,
				};
			}),
		);

		return reply.viewAsync('apps-list', {
			title: 'Apps — PAS',
			activePage: 'apps',
			apps: appList,
			users,
		});
	});

	// Toggle app for a user
	server.post<{
		Params: { appId: string };
		Body: { userId: string; enabled: string };
	}>('/apps/:appId/toggle', async (request, reply) => {
		const { appId } = request.params;
		const { userId, enabled } = request.body;

		// Format validation (defense-in-depth against injection)
		if (!/^[a-z0-9-]+$/.test(appId)) {
			return reply.status(400).type('text/html').send('Invalid app ID format');
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
			return reply.status(400).type('text/html').send('Invalid user ID format');
		}

		// Validate appId exists in registry
		if (!registry.getApp(appId)) {
			return reply.status(404).type('text/html').send('App not found');
		}

		// Validate userId exists in config
		if (!config.users.some((u) => u.id === userId)) {
			return reply.status(400).type('text/html').send('User not found');
		}

		const newState = enabled !== 'true'; // Toggle: if currently true, set false

		await appToggle.setEnabled(userId, appId, newState);
		logger.info({ appId, userId, enabled: newState }, 'App toggled via GUI');

		// Return just the toggle button (htmx partial)
		const buttonClass = newState ? 'outline' : '';
		const buttonText = newState ? 'Enabled' : 'Disabled';
		const statusClass = newState ? 'status-ok' : 'status-err';
		const safeAppId = escapeHtml(appId);
		const hxVals = escapeHtml(JSON.stringify({ userId, enabled: String(newState) }));

		return reply
			.type('text/html')
			.send(
				`<button class="${buttonClass}" hx-post="/gui/apps/${safeAppId}/toggle" hx-vals="${hxVals}" hx-swap="outerHTML" style="padding:0.25rem 0.5rem;margin:0;font-size:0.8rem"><span class="${statusClass}">${buttonText}</span></button>`,
			);
	});

	// App detail
	server.get<{ Params: { appId: string } }>('/apps/:appId', async (request, reply) => {
		const { appId } = request.params;
		const app = registry.getApp(appId);

		if (!app) {
			return reply.status(404).viewAsync('app-detail', {
				title: 'App Not Found — PAS',
				activePage: 'apps',
				app: null,
				appId,
			});
		}

		// Load per-user config values if app has user_config
		const configDefs = app.manifest.user_config ?? [];
		const userConfigs: Array<{
			userId: string;
			userName: string;
			values: Record<string, unknown>;
		}> = [];

		if (configDefs.length > 0) {
			const appConfig = getAppConfigService(appId, configDefs);
			for (const user of config.users) {
				try {
					const values = await appConfig.getAll(user.id);
					userConfigs.push({ userId: user.id, userName: user.name, values });
				} catch {
					userConfigs.push({ userId: user.id, userName: user.name, values: {} });
				}
			}
		}

		return reply.viewAsync('app-detail', {
			title: `${app.manifest.app.name} — PAS`,
			activePage: 'apps',
			app: {
				id: app.manifest.app.id,
				name: app.manifest.app.name,
				version: app.manifest.app.version,
				description: app.manifest.app.description,
				author: app.manifest.app.author,
				capabilities: app.manifest.capabilities,
				requirements: app.manifest.requirements,
				userConfig: configDefs,
			},
			userConfigs,
			csrfToken: (request as unknown as Record<string, unknown>).csrfToken,
		});
	});
}
