/**
 * App registry: central registry for app discovery, loading, and lifecycle.
 *
 * Orchestrates the full app loading pipeline: discover → validate →
 * import → build CoreServices → init. Provides lookup methods for
 * the router and other infrastructure components.
 */

import type { Logger } from 'pino';
import type { AppModule, CoreServices } from '../../types/app-module.js';
import type { SystemConfig } from '../../types/config.js';
import type { AppManifest } from '../../types/manifest.js';
import { AppLoader } from './loader.js';
import { ManifestCache } from './manifest-cache.js';

/** A fully loaded and initialized app. */
export interface RegisteredApp {
	manifest: AppManifest;
	module: AppModule;
	appDir: string;
}

/** Factory function that creates scoped CoreServices for a specific app. */
export type ServiceFactory = (manifest: AppManifest, appDir: string) => CoreServices;

export interface AppRegistryOptions {
	appsDir: string;
	config: SystemConfig;
	logger: Logger;
}

export class AppRegistry {
	private readonly apps = new Map<string, RegisteredApp>();
	private readonly cache: ManifestCache;
	private readonly loader: AppLoader;
	private readonly config: SystemConfig;
	private readonly logger: Logger;

	constructor(options: AppRegistryOptions) {
		this.config = options.config;
		this.logger = options.logger;
		this.cache = new ManifestCache(options.logger);
		this.loader = new AppLoader({ appsDir: options.appsDir, logger: options.logger });
	}

	/**
	 * Load all apps: discover, validate, import, build CoreServices, init.
	 * Invalid apps are logged and skipped — never crash the system.
	 */
	async loadAll(serviceFactory: ServiceFactory): Promise<void> {
		const appDirs = await this.loader.discoverApps();
		const loaded: string[] = [];
		const skipped: Array<{ dir: string; reason: string }> = [];

		for (const appDir of appDirs) {
			const manifest = await this.loader.loadManifest(appDir);
			if (!manifest) {
				skipped.push({ dir: appDir, reason: 'invalid manifest' });
				continue;
			}

			const module = await this.loader.importModule(appDir);
			if (!module) {
				skipped.push({ dir: appDir, reason: 'import failed' });
				continue;
			}

			// Build scoped CoreServices for this app
			const services = serviceFactory(manifest, appDir);

			try {
				await module.init(services);
			} catch (error) {
				this.logger.error({ appId: manifest.app.id, error }, 'App init() failed — skipping');
				skipped.push({ dir: appDir, reason: 'init failed' });
				continue;
			}

			this.cache.add(manifest, appDir);
			this.apps.set(manifest.app.id, { manifest, module, appDir });
			loaded.push(manifest.app.id);
		}

		this.logger.info(
			{ loaded, skipped: skipped.map((s) => `${s.dir} (${s.reason})`), total: appDirs.length },
			`App registry: loaded ${loaded.length} app(s), skipped ${skipped.length}`,
		);
	}

	/** Get a loaded app by ID. */
	getApp(appId: string): RegisteredApp | undefined {
		return this.apps.get(appId);
	}

	/** Get the manifest cache for building routing tables. */
	getManifestCache(): ManifestCache {
		return this.cache;
	}

	/** Get all loaded app IDs. */
	getLoadedAppIds(): string[] {
		return [...this.apps.keys()];
	}

	/** Get all loaded apps. */
	getAll(): RegisteredApp[] {
		return [...this.apps.values()];
	}

	/**
	 * Shut down all loaded apps gracefully.
	 * Calls shutdown() in reverse load order. Each call is isolated.
	 */
	async shutdownAll(): Promise<void> {
		const appIds = [...this.apps.keys()].reverse();

		for (const appId of appIds) {
			const app = this.apps.get(appId);
			if (!app?.module.shutdown) continue;

			try {
				await app.module.shutdown();
				this.logger.debug({ appId }, 'App shut down');
			} catch (error) {
				this.logger.error({ appId, error }, 'App shutdown failed');
			}
		}
	}
}

// Re-export for convenience
export { ManifestCache } from './manifest-cache.js';
export type { ManifestCacheEntry, CommandMapEntry, IntentTableEntry } from './manifest-cache.js';
