/**
 * App toggle store.
 *
 * Manages per-user app enable/disable overrides. Stored in
 * data/system/app-toggles.yaml. Overrides take precedence
 * over the default enabled_apps list from config/pas.yaml.
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';

/** Shape of the YAML file: { userId: { appId: boolean } } */
type ToggleData = Record<string, Record<string, boolean>>;

export interface AppToggleStoreOptions {
	dataDir: string;
	logger: Logger;
}

export class AppToggleStore {
	private readonly filePath: string;
	private readonly logger: Logger;

	constructor(options: AppToggleStoreOptions) {
		this.filePath = join(options.dataDir, 'system', 'app-toggles.yaml');
		this.logger = options.logger;
	}

	/**
	 * Check if an app is enabled for a user.
	 * Override takes precedence over the default enabled apps list.
	 */
	async isEnabled(userId: string, appId: string, defaultEnabledApps: string[]): Promise<boolean> {
		const data = await this.load();
		const userOverrides = data[userId];

		if (userOverrides && appId in userOverrides) {
			return userOverrides[appId] ?? false;
		}

		// Fall back to config defaults
		return defaultEnabledApps.includes('*') || defaultEnabledApps.includes(appId);
	}

	/**
	 * Set the enabled/disabled state for an app for a user.
	 */
	async setEnabled(userId: string, appId: string, enabled: boolean): Promise<void> {
		if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error(`Invalid userId: ${userId}`);
		if (!/^[a-z0-9-]+$/.test(appId)) throw new Error(`Invalid appId: ${appId}`);

		const data = await this.load();

		if (!data[userId]) {
			data[userId] = {};
		}
		data[userId][appId] = enabled;

		await writeYamlFile(this.filePath, data);
		this.logger.info({ userId, appId, enabled }, 'App toggle updated');
	}

	/**
	 * Get all overrides for a user.
	 */
	async getOverrides(userId: string): Promise<Record<string, boolean>> {
		const data = await this.load();
		return data[userId] ?? {};
	}

	/**
	 * Get all overrides for all users.
	 */
	async getAllOverrides(): Promise<ToggleData> {
		return this.load();
	}

	private async load(): Promise<ToggleData> {
		const data = await readYamlFile<ToggleData>(this.filePath);
		return data ?? {};
	}
}
