/**
 * Config writer — syncs the users array back to pas.yaml.
 *
 * Delegates to mutatePasYaml so users-array writes serialise against the
 * same file lock as system-key writes (REQ-SETTINGS-024).
 * If the file does not exist it is created (bootstrap case only).
 */

import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import type { RegisteredUser } from '../../types/users.js';
import { ensureDir } from '../../utils/file.js';
import { mutatePasYaml } from './pas-yaml-mutator.js';
import { dirname } from 'node:path';

/**
 * Sync a list of RegisteredUsers to the `users` key in pas.yaml.
 *
 * All other top-level keys in the file are preserved parse-equivalently.
 * If the file does not exist it is created with just the users section
 * (fresh-install bootstrap path).
 *
 * @param configPath - Absolute path to pas.yaml.
 * @param users      - Users to write. camelCase fields are converted to snake_case.
 */
export async function syncUsersToConfig(
	configPath: string,
	users: ReadonlyArray<RegisteredUser>,
): Promise<void> {
	const usersSnake = users.map((u) => ({
		id: u.id,
		name: u.name,
		is_admin: u.isAdmin,
		enabled_apps: u.enabledApps,
		shared_scopes: u.sharedScopes,
		...(u.householdId !== undefined ? { household_id: u.householdId } : {}),
	}));

	try {
		// Happy path: file exists — go through the shared lock + mutator.
		await mutatePasYaml(configPath, (parsed) => {
			parsed['users'] = usersSnake;
			return parsed;
		});
	} catch (err) {
		// Fresh-install bootstrap: mutatePasYaml throws ENOENT when the file
		// doesn't exist. Create it with only the users section.
		if ((err as NodeJS.ErrnoException).message?.includes('not found')) {
			await ensureDir(dirname(configPath));
			await writeFile(configPath, stringify({ users: usersSnake }), 'utf-8');
			return;
		}
		throw err;
	}
}
