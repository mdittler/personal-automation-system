/**
 * In-memory cache of validated app manifests.
 *
 * Stores manifests and builds O(1) lookup tables for
 * command routing, intent classification, and photo routing.
 */

import type { Logger } from 'pino';
import type { AppManifest, ManifestCommand } from '../../types/manifest.js';

/** A cached manifest entry with its filesystem location. */
export interface ManifestCacheEntry {
	manifest: AppManifest;
	appDir: string;
}

/** Command lookup entry mapping a /command to its owning app. */
export interface CommandMapEntry {
	appId: string;
	command: ManifestCommand;
}

/** Intent table entry mapping an intent category to its owning app. */
export interface IntentTableEntry {
	category: string;
	appId: string;
}

export class ManifestCache {
	private readonly entries = new Map<string, ManifestCacheEntry>();
	private readonly logger: Logger | null;

	constructor(logger?: Logger) {
		this.logger = logger ?? null;
	}

	/** Add a validated manifest to the cache. */
	add(manifest: AppManifest, appDir: string): void {
		this.entries.set(manifest.app.id, { manifest, appDir });
	}

	/** Get a cached manifest entry by app ID. */
	get(appId: string): ManifestCacheEntry | undefined {
		return this.entries.get(appId);
	}

	/** Get all cached manifest entries. */
	getAll(): ManifestCacheEntry[] {
		return [...this.entries.values()];
	}

	/** Check if an app is in the cache. */
	has(appId: string): boolean {
		return this.entries.has(appId);
	}

	/** Number of cached manifests. */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * Build an O(1) command lookup map from all cached manifests.
	 * Warns and skips if two apps register the same command.
	 */
	buildCommandMap(): Map<string, CommandMapEntry> {
		const map = new Map<string, CommandMapEntry>();

		for (const { manifest } of this.entries.values()) {
			const commands = manifest.capabilities?.messages?.commands ?? [];
			for (const command of commands) {
				const existing = map.get(command.name);
				if (existing) {
					this.logger?.warn(
						{ command: command.name, existingApp: existing.appId, newApp: manifest.app.id },
						'Command collision — keeping first registration, skipping duplicate',
					);
					continue;
				}
				map.set(command.name, { appId: manifest.app.id, command });
			}
		}

		return map;
	}

	/**
	 * Build the intent table for LLM classification.
	 * Each entry maps an intent category string to its owning app ID.
	 */
	buildIntentTable(): IntentTableEntry[] {
		const table: IntentTableEntry[] = [];

		for (const { manifest } of this.entries.values()) {
			const intents = manifest.capabilities?.messages?.intents ?? [];
			for (const intent of intents) {
				table.push({ category: intent, appId: manifest.app.id });
			}
		}

		return table;
	}

	/**
	 * Build the photo intent table for photo classification.
	 * Each entry maps a photo intent category to its owning app ID.
	 */
	buildPhotoIntentTable(): IntentTableEntry[] {
		const table: IntentTableEntry[] = [];

		for (const { manifest } of this.entries.values()) {
			if (!manifest.capabilities?.messages?.accepts_photos) continue;
			const photoIntents = manifest.capabilities.messages.photo_intents ?? [];
			for (const intent of photoIntents) {
				table.push({ category: intent, appId: manifest.app.id });
			}
		}

		return table;
	}

	/** Return all app IDs whose manifests declare accepts_photos: true. */
	getPhotoAppIds(): string[] {
		const ids: string[] = [];
		for (const { manifest } of this.entries.values()) {
			if (manifest.capabilities?.messages?.accepts_photos) {
				ids.push(manifest.app.id);
			}
		}
		return ids;
	}
}
