/**
 * Read-only app metadata service — exposes manifest info without module access.
 *
 * Apps declare 'app-metadata' in requirements.services to receive this.
 * Only provides identity, commands, and capability summaries from manifests.
 * Never exposes AppModule instances, file paths, or write methods.
 */

/** Summary of an installed app, derived from its manifest. */
export interface AppInfo {
	id: string;
	name: string;
	description: string;
	version: string;
	category?: string;
	commands: Array<{ name: string; description: string; args?: string[] }>;
	intents: string[];
	hasSchedules: boolean;
	hasEvents: boolean;
	acceptsPhotos: boolean;
}

/** Flat command entry across all apps. */
export interface CommandInfo {
	command: string;
	description: string;
	appId: string;
	appName: string;
}

/** Read-only metadata about installed apps. */
export interface AppMetadataService {
	/** Get metadata for all installed apps. */
	getInstalledApps(): AppInfo[];
	/** Get metadata filtered to apps enabled for a specific user. */
	getEnabledApps(userId: string): Promise<AppInfo[]>;
	/** Get metadata for a single app. Returns null if not found. */
	getAppInfo(appId: string): AppInfo | null;
	/** Get all commands across all installed apps. */
	getCommandList(): CommandInfo[];
}
