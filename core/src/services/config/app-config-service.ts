/**
 * App configuration service.
 *
 * Provides per-user config values for an app. Values come from:
 * 1. User overrides (stored in data/system/app-config/<appId>/<userId>.yaml)
 * 2. Manifest defaults (from the app's manifest user_config section)
 *
 * User overrides take precedence over manifest defaults.
 */

import { join } from 'node:path';
import type { AppConfigService } from '../../types/config.js';
import type { ManifestUserConfig } from '../../types/manifest.js';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';

export interface AppConfigServiceOptions {
	/** Absolute path to the data directory. */
	dataDir: string;
	/** App ID. */
	appId: string;
	/** Default values from the app's manifest user_config. */
	defaults: ManifestUserConfig[];
}

export class AppConfigServiceImpl implements AppConfigService {
	private readonly dataDir: string;
	private readonly appId: string;
	private readonly defaultsMap: Map<string, unknown>;
	private userId: string | null = null;

	constructor(options: AppConfigServiceOptions) {
		this.dataDir = options.dataDir;
		this.appId = options.appId;

		// Build a map of defaults from manifest
		this.defaultsMap = new Map();
		for (const item of options.defaults) {
			this.defaultsMap.set(item.key, item.default);
		}
	}

	/**
	 * Set the current user context for config lookups.
	 * Called by the infrastructure before dispatching to an app handler.
	 */
	setUserId(userId: string): void {
		this.userId = userId;
	}

	async get<T>(key: string): Promise<T> {
		const overrides = await this.loadOverrides();
		if (overrides !== null && key in overrides) {
			return overrides[key] as T;
		}

		if (this.defaultsMap.has(key)) {
			return this.defaultsMap.get(key) as T;
		}

		throw new Error(`Config key "${key}" not found for app "${this.appId}"`);
	}

	async getAll(userId?: string): Promise<Record<string, unknown>> {
		const result: Record<string, unknown> = {};

		// Start with defaults
		for (const [key, value] of this.defaultsMap) {
			result[key] = value;
		}

		// Layer on user overrides
		const overrides = await this.loadOverrides(userId);
		if (overrides !== null) {
			for (const [key, value] of Object.entries(overrides)) {
				result[key] = value;
			}
		}

		return result;
	}

	/**
	 * Set all config overrides for a specific user.
	 * Used by the management GUI to update per-user app config.
	 */
	async setAll(userId: string, values: Record<string, unknown>): Promise<void> {
		if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error(`Invalid userId: ${userId}`);

		const overridePath = join(this.dataDir, 'system', 'app-config', this.appId, `${userId}.yaml`);

		await writeYamlFile(overridePath, values);
	}

	private async loadOverrides(explicitUserId?: string): Promise<Record<string, unknown> | null> {
		const uid = explicitUserId ?? this.userId;
		if (uid === null) return null;
		if (!/^[a-zA-Z0-9_-]+$/.test(uid)) return null;

		const overridePath = join(this.dataDir, 'system', 'app-config', this.appId, `${uid}.yaml`);

		return readYamlFile<Record<string, unknown>>(overridePath);
	}
}
