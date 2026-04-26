/**
 * App configuration service.
 *
 * Provides per-user config values for an app. Values come from:
 * 1. User overrides (stored in data/system/app-config/<appId>/<userId>.yaml)
 * 2. Manifest defaults (from the app's manifest user_config section)
 *
 * User overrides take precedence over manifest defaults.
 *
 * The active user is resolved from the request-scoped AsyncLocalStorage
 * context (`requestContext`). Infrastructure establishes the context at
 * every dispatch entry point (Telegram messages, callbacks, scheduled
 * jobs, alert actions, API calls), so app code can call `get(key)` without
 * ever handling userId explicitly.
 */

import { join } from 'node:path';
import type { AppConfigService } from '../../types/config.js';
import type { ManifestUserConfig } from '../../types/manifest.js';
import { withFileLock } from '../../utils/file-mutex.js';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';
import { getCurrentUserId } from '../context/request-context.js';

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

	constructor(options: AppConfigServiceOptions) {
		this.dataDir = options.dataDir;
		this.appId = options.appId;

		// Build a map of defaults from manifest
		this.defaultsMap = new Map();
		for (const item of options.defaults) {
			this.defaultsMap.set(item.key, item.default);
		}
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

	/** Expose raw user overrides without merging manifest defaults. */
	async getOverrides(userId: string): Promise<Record<string, unknown> | null> {
		return this.loadOverrides(userId);
	}

	/** Locked read-modify-write of raw overrides. Writes only raw override keys — never manifest defaults. */
	async updateOverrides(userId: string, partial: Record<string, unknown>): Promise<void> {
		if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error(`Invalid userId: ${userId}`);
		if (Object.keys(partial).length === 0) return;

		const overridePath = join(this.dataDir, 'system', 'app-config', this.appId, `${userId}.yaml`);

		await withFileLock(overridePath, async () => {
			const existing = (await readYamlFile<Record<string, unknown>>(overridePath)) ?? {};
			await writeYamlFile(overridePath, { ...existing, ...partial });
		});
	}

	/**
	 * Resolve the userId for an override lookup.
	 *
	 * Priority:
	 * 1. `explicitUserId` argument — used by `getAll(userId)` for the GUI,
	 *    which reads another user's config from outside that user's
	 *    request context.
	 * 2. The current `requestContext` userId — the normal path for
	 *    `get()` calls from inside an app handler.
	 *
	 * Returns null when neither source yields a userId (e.g. `get()`
	 * called outside any dispatch scope, like a one-off startup probe).
	 * A null result causes callers to fall through to manifest defaults.
	 */
	private async loadOverrides(explicitUserId?: string): Promise<Record<string, unknown> | null> {
		const uid = explicitUserId ?? getCurrentUserId() ?? null;
		if (uid === null) return null;
		if (!/^[a-zA-Z0-9_-]+$/.test(uid)) return null;

		const overridePath = join(this.dataDir, 'system', 'app-config', this.appId, `${uid}.yaml`);

		return readYamlFile<Record<string, unknown>>(overridePath);
	}
}
