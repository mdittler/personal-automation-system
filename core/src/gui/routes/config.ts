/**
 * Config route.
 *
 * GET /gui/config — redirects to dashboard (config merged into dashboard).
 * POST /gui/config/:appId/:userId — update per-user app config.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppRegistry } from '../../services/app-registry/index.js';
import { AppConfigServiceImpl } from '../../services/config/app-config-service.js';
import type { SystemConfig } from '../../types/config.js';
import type { ManifestUserConfig } from '../../types/manifest.js';

export interface ConfigOptions {
	registry: AppRegistry;
	config: SystemConfig;
	dataDir: string;
	logger: Logger;
}

export function registerConfigRoutes(server: FastifyInstance, options: ConfigOptions): void {
	const { registry, config, dataDir, logger } = options;

	// Cache AppConfigServiceImpl instances per appId to avoid re-creation on each request
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

	// Redirect to dashboard (config is now merged into dashboard)
	server.get('/config', async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.redirect('/gui/');
	});

	// Update per-user app config
	server.post<{
		Params: { appId: string; userId: string };
	}>('/config/:appId/:userId', async (request, reply) => {
		const { appId, userId } = request.params;
		const body = request.body as Record<string, string>;

		// Format validation (defense-in-depth against injection)
		if (!/^[a-z0-9-]+$/.test(appId)) {
			return reply.status(400).send('Invalid app ID format');
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
			return reply.status(400).send('Invalid user ID format');
		}

		const app = registry.getApp(appId);
		if (!app) {
			return reply.status(404).send('App not found');
		}

		// Validate userId exists in config
		if (!config.users.some((u) => u.id === userId)) {
			return reply.status(400).send('User not found');
		}

		const configDefs = app.manifest.user_config ?? [];
		const knownKeys = new Set(configDefs.map((d) => d.key));

		// Filter to only known keys and coerce types based on manifest definitions
		const validated: Record<string, unknown> = {};
		for (const [key, rawValue] of Object.entries(body)) {
			// Skip CSRF token field and unknown keys
			if (key === '_csrf') continue;
			if (!knownKeys.has(key)) {
				logger.warn({ appId, userId, key }, 'Unknown config key submitted, ignoring');
				continue;
			}

			const def = configDefs.find((d) => d.key === key);
			if (def?.type === 'number') {
				const num = Number(rawValue);
				validated[key] = Number.isNaN(num) ? 0 : num;
			} else if (def?.type === 'boolean') {
				validated[key] = rawValue === 'true' || rawValue === '1' || rawValue === 'on';
			} else {
				validated[key] = String(rawValue);
			}
		}

		const appConfig = getAppConfigService(appId, configDefs);

		try {
			await appConfig.setAll(userId, validated);
			logger.info({ appId, userId }, 'App config updated via GUI');
		} catch (err) {
			logger.error({ appId, userId, error: err }, 'Failed to update app config');
			return reply.status(500).send('Failed to update config');
		}

		return reply.redirect(`/gui/apps/${appId}`);
	});
}
