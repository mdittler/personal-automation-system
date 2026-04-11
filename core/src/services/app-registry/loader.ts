/**
 * App loader: discovers, validates, and dynamically imports app modules.
 *
 * Scans the apps/ directory for subdirectories containing manifest.yaml,
 * validates each manifest, and loads app modules via dynamic import.
 * Invalid manifests or failing imports are logged and skipped (URS-NF-014).
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { validateManifest } from '../../schemas/validate-manifest.js';
import type { AppModule } from '../../types/app-module.js';
import type { AppManifest } from '../../types/manifest.js';
import { readYamlFile } from '../../utils/yaml.js';
import { warnScopePathPrefix } from '../data-store/paths.js';

/** A successfully loaded app with its manifest and module. */
export interface LoadedApp {
	manifest: AppManifest;
	module: AppModule;
	appDir: string;
}

export interface AppLoaderOptions {
	appsDir: string;
	logger: Logger;
}

export class AppLoader {
	private readonly appsDir: string;
	private readonly logger: Logger;

	constructor(options: AppLoaderOptions) {
		this.appsDir = options.appsDir;
		this.logger = options.logger;
	}

	/**
	 * Discover all app directories under appsDir.
	 * Returns absolute paths to directories that contain a manifest.yaml.
	 */
	async discoverApps(): Promise<string[]> {
		const appDirs: string[] = [];

		let entries: string[];
		try {
			entries = await readdir(this.appsDir);
		} catch {
			this.logger.warn({ appsDir: this.appsDir }, 'Apps directory not found — no apps to load');
			return [];
		}

		for (const entry of entries) {
			const appDir = join(this.appsDir, entry);
			try {
				const stats = await stat(appDir);
				if (!stats.isDirectory()) continue;

				const manifestPath = join(appDir, 'manifest.yaml');
				const manifestStats = await stat(manifestPath).catch(() => null);
				if (manifestStats?.isFile()) {
					appDirs.push(appDir);
				}
			} catch {
				// Skip entries that can't be read
			}
		}

		this.logger.debug(
			{ count: appDirs.length, appsDir: this.appsDir },
			'Discovered app directories',
		);
		return appDirs;
	}

	/**
	 * Load and validate a single app's manifest.
	 * Returns null if the file can't be read or validation fails.
	 */
	async loadManifest(appDir: string): Promise<AppManifest | null> {
		const manifestPath = join(appDir, 'manifest.yaml');

		const data = await readYamlFile(manifestPath);
		if (data == null) {
			this.logger.error({ path: manifestPath }, 'Failed to read manifest file');
			return null;
		}

		const result = validateManifest(data);
		if (!result.valid) {
			this.logger.error(
				{ path: manifestPath, errors: result.errors },
				'Invalid app manifest — skipping',
			);
			return null;
		}

		const manifest = result.manifest;

		// Warn about scope paths using the {appId}/ prefix convention (F7)
		const appId = manifest.app.id;
		const userScopes = manifest.requirements?.data?.user_scopes ?? [];
		const sharedScopes = manifest.requirements?.data?.shared_scopes ?? [];
		const scopeWarnings = [
			...warnScopePathPrefix(appId, userScopes),
			...warnScopePathPrefix(appId, sharedScopes),
		];
		for (const warning of scopeWarnings) {
			this.logger.warn({ appId, path: manifestPath }, warning);
		}

		return manifest;
	}

	/**
	 * Dynamically import the app module from an app directory.
	 * Tries the compiled .js first, then falls back to .ts for dev mode.
	 * Returns null if the import fails.
	 */
	async importModule(appDir: string): Promise<AppModule | null> {
		// Try possible entry points in order: root first, then src/ subdirectory
		const candidates = ['index.js', 'index.ts', 'src/index.js', 'src/index.ts'];

		for (const candidate of candidates) {
			const modulePath = join(appDir, candidate);
			try {
				const moduleStats = await stat(modulePath).catch(() => null);
				if (!moduleStats?.isFile()) continue;

				// Use file URL for cross-platform dynamic import compatibility
				const moduleUrl = pathToFileURL(modulePath).href;
				const imported = (await import(moduleUrl)) as Record<string, unknown>;

				// The module should have a default export or named exports matching AppModule
				const appModule = (imported.default ?? imported) as AppModule;

				if (typeof appModule.init !== 'function' || typeof appModule.handleMessage !== 'function') {
					this.logger.error(
						{ appDir, entry: candidate },
						'App module missing required init() or handleMessage() — skipping',
					);
					return null;
				}

				this.logger.debug({ appDir, entry: candidate }, 'Imported app module');
				return appModule;
			} catch (error) {
				this.logger.debug(
					{ appDir, entry: candidate, error },
					'Failed to import app module candidate',
				);
				// Try next candidate
			}
		}

		this.logger.error({ appDir }, 'No valid app module found — skipping');
		return null;
	}
}
