/**
 * App metadata service — read-only manifest wrapper.
 *
 * Exposes app identity, commands, and capability summaries from manifests.
 * Never exposes AppModule instances, file paths, or write methods.
 * Reads lazily from AppRegistry (populated by the time any message is handled).
 */

import type { AppInfo, AppMetadataService, CommandInfo } from '../../types/app-metadata.js';
import type { SystemConfig } from '../../types/config.js';
import type { AppManifest } from '../../types/manifest.js';
import type { AppRegistry } from '../app-registry/index.js';
import type { AppToggleStore } from '../app-toggle/index.js';

export interface AppMetadataServiceOptions {
	registry: AppRegistry;
	appToggle: AppToggleStore;
	config: SystemConfig;
}

export class AppMetadataServiceImpl implements AppMetadataService {
	private readonly registry: AppRegistry;
	private readonly appToggle: AppToggleStore;
	private readonly config: SystemConfig;

	constructor(options: AppMetadataServiceOptions) {
		this.registry = options.registry;
		this.appToggle = options.appToggle;
		this.config = options.config;
	}

	getInstalledApps(): AppInfo[] {
		return this.registry.getAll().map((app) => toAppInfo(app.manifest));
	}

	async getEnabledApps(userId: string): Promise<AppInfo[]> {
		const user = this.config.users.find((u) => u.id === userId);
		const defaultEnabled = user?.enabledApps ?? [];
		const allApps = this.registry.getAll();
		const result: AppInfo[] = [];

		for (const app of allApps) {
			const enabled = await this.appToggle.isEnabled(userId, app.manifest.app.id, defaultEnabled);
			if (enabled) {
				result.push(toAppInfo(app.manifest));
			}
		}

		return result;
	}

	getAppInfo(appId: string): AppInfo | null {
		const app = this.registry.getApp(appId);
		if (!app) return null;
		return toAppInfo(app.manifest);
	}

	getCommandList(): CommandInfo[] {
		const commands: CommandInfo[] = [];
		for (const app of this.registry.getAll()) {
			const manifest = app.manifest;
			for (const cmd of manifest.capabilities?.messages?.commands ?? []) {
				commands.push({
					command: cmd.name,
					description: cmd.description,
					appId: manifest.app.id,
					appName: manifest.app.name,
				});
			}
		}
		return commands;
	}
}

/** Map a manifest to a safe AppInfo (no module/path exposure). */
function toAppInfo(manifest: AppManifest): AppInfo {
	const messages = manifest.capabilities?.messages;
	const events = manifest.capabilities?.events;
	const schedules = manifest.capabilities?.schedules;

	return {
		id: manifest.app.id,
		name: manifest.app.name,
		description: manifest.app.description,
		version: manifest.app.version,
		category: manifest.app.category,
		commands: (messages?.commands ?? []).map((c) => ({
			name: c.name,
			description: c.description,
			args: c.args ? [...c.args] : undefined,
		})),
		intents: [...(messages?.intents ?? [])],
		hasSchedules: (schedules?.length ?? 0) > 0,
		hasEvents: (events?.emits?.length ?? 0) > 0 || (events?.subscribes?.length ?? 0) > 0,
		acceptsPhotos: messages?.accepts_photos ?? false,
	};
}
