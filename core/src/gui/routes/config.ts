/**
 * Config route.
 *
 * GET /gui/config — redirects to dashboard (config merged into dashboard).
 * POST /gui/config/:appId/:userId — update per-user app config.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { requirePlatformAdmin } from '../../gui/guards/require-platform-admin.js';
import type { AppRegistry } from '../../services/app-registry/index.js';
import { AppConfigServiceImpl } from '../../services/config/app-config-service.js';
import { coerceUserConfigValue } from '../../services/config/coerce-user-config.js';
import type { SettingsRegistry } from '../../services/settings/settings-registry.js';
import type {
	BatchResult,
	SettingsWriter,
	WriteRequest,
} from '../../services/settings/settings-writer.js';
import type { SystemConfig } from '../../types/config.js';
import type { ManifestUserConfig } from '../../types/manifest.js';

export interface ConfigOptions {
	registry: AppRegistry;
	config: SystemConfig;
	dataDir: string;
	logger: Logger;
	/**
	 * Routes registry-eligible chatbot keys through SettingsWriter.writeBatch so
	 * the registered post-write hook is the single source of truth for side-effects.
	 */
	settingsWriter: SettingsWriter;
	settingsRegistry: SettingsRegistry;
}

export function registerConfigRoutes(server: FastifyInstance, options: ConfigOptions): void {
	const { registry, config, dataDir, logger, settingsWriter, settingsRegistry } = options;

	const platformAdminOnly = { preHandler: [requirePlatformAdmin] };

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
	server.get(
		'/config',
		platformAdminOnly,
		async (_request: FastifyRequest, reply: FastifyReply) => {
			return reply.redirect('/gui/');
		},
	);

	// Update per-user app config
	server.post<{
		Params: { appId: string; userId: string };
	}>('/config/:appId/:userId', platformAdminOnly, async (request, reply) => {
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

		// Partition into writer-routed (chatbot) and legacy-routed (all other apps).
		// All chatbot keys go through SettingsWriter.writeBatch (updateOverrides/merge semantics,
		// post-write hooks fire). Mixing writeBatch with appConfig.setAll on the same override
		// file would cause setAll to erase the writer's updateOverrides changes, so chatbot
		// keys that are absent from the registry are treated as a wiring error.
		// Non-chatbot apps use the existing appConfig.setAll path unchanged.
		const writerItems: WriteRequest[] = [];
		const legacyValidated: Record<string, unknown> = {};
		const coercionFailures: string[] = [];

		for (const [key, rawValue] of Object.entries(body)) {
			if (key === '_csrf') continue;
			if (!knownKeys.has(key)) {
				logger.warn({ appId, userId, key }, 'Unknown config key submitted, ignoring');
				continue;
			}

			if (appId === 'chatbot') {
				if (settingsRegistry.getByAppKey(appId, key) === undefined) {
					logger.error(
						{ appId, userId, key },
						'Chatbot key not in SettingsRegistry — refusing mixed setAll/writeBatch write',
					);
					return reply.status(500).send('Internal configuration error');
				}
				writerItems.push({ userId, appId, key, rawValue, source: 'admin-confirmed' });
			} else {
				const def = configDefs.find((d) => d.key === key)!;
				const result = coerceUserConfigValue(def, rawValue);
				if (!result.ok) {
					coercionFailures.push(`${key}: ${result.reason}`);
				} else {
					legacyValidated[key] = result.coerced;
				}
			}
		}

		// Validate writer items (sync, no I/O) before any persistence.
		for (const item of writerItems) {
			const v = settingsWriter.validate(item);
			if (!v.ok) {
				coercionFailures.push(`${item.key}: ${v.reason}`);
			}
		}

		if (coercionFailures.length > 0) {
			logger.warn(
				{ appId, userId, failures: coercionFailures },
				'Config update rejected: coercion failure',
			);
			return reply.status(400).send(`Invalid config values: ${coercionFailures.join('; ')}`);
		}

		// Persist writer items first (merge semantics via updateOverrides).
		if (writerItems.length > 0) {
			let batchResult: BatchResult;
			try {
				batchResult = await settingsWriter.writeBatch(writerItems);
			} catch (err) {
				logger.error({ appId, userId, err }, 'SettingsWriter.writeBatch threw');
				return reply.status(500).send('Failed to update config');
			}
			const appResult = batchResult.perApp.get(appId);
			if (!appResult || !appResult.ok) {
				logger.error(
					{ appId, userId, reason: appResult?.reason },
					'SettingsWriter.writeBatch reported failure',
				);
				return reply.status(500).send('Failed to update config');
			}
		}

		// Persist legacy keys via setAll (rewrite semantics — non-chatbot apps only).
		if (Object.keys(legacyValidated).length > 0) {
			const appConfig = getAppConfigService(appId, configDefs);
			try {
				await appConfig.setAll(userId, legacyValidated);
			} catch (err) {
				logger.error({ appId, userId, error: err }, 'Failed to update app config');
				return reply.status(500).send('Failed to update config');
			}
		}

		logger.info({ appId, userId }, 'App config updated via GUI');
		return reply.redirect(`/gui/apps/${appId}`);
	});
}
