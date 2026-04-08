/**
 * Config writer — syncs the users array back to pas.yaml.
 *
 * Reads the existing YAML file (or starts with an empty object if it doesn't
 * exist), replaces the `users` key with the supplied users converted to
 * snake_case, then writes the result back atomically.
 */

import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import type { RegisteredUser } from '../../types/users.js';
import { atomicWrite } from '../../utils/file.js';

/**
 * Sync a list of RegisteredUsers to the `users` key in pas.yaml.
 *
 * All other top-level keys in the file are preserved unchanged.
 * If the file does not exist it is created.
 *
 * @param configPath - Absolute path to pas.yaml.
 * @param users      - Users to write. camelCase fields are converted to snake_case.
 */
export async function syncUsersToConfig(
	configPath: string,
	users: ReadonlyArray<RegisteredUser>,
): Promise<void> {
	// Read existing file, or start with an empty object if it doesn't exist.
	let rawText = '';
	try {
		rawText = await readFile(configPath, 'utf-8');
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
		// File doesn't exist — we'll create it with just the users section.
	}

	// Parse to object (null if file was empty).
	const config: Record<string, unknown> =
		(rawText ? (parse(rawText) as Record<string, unknown>) : null) ?? {};

	// Replace the users key, converting camelCase → snake_case.
	config.users = users.map((u) => ({
		id: u.id,
		name: u.name,
		is_admin: u.isAdmin,
		enabled_apps: u.enabledApps,
		shared_scopes: u.sharedScopes,
	}));

	// Serialize and write atomically (atomicWrite creates parent dirs as needed).
	const output = stringify(config);
	await atomicWrite(configPath, output);
}
