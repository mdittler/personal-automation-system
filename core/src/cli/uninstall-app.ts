#!/usr/bin/env node
/**
 * CLI entry point for uninstalling a PAS app.
 *
 * Usage: pnpm uninstall-app <app-id>
 */

import { rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Valid app ID pattern — must match manifest schema. */
const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Built-in apps that cannot be uninstalled. */
const PROTECTED_APPS = new Set(['echo', 'chatbot']);

function getAppsDir(): string {
	return resolve(join(__dirname, '..', '..', '..', 'apps'));
}

async function main() {
	const args = process.argv.slice(2);
	const appId = args[0];

	if (!appId) {
		console.error('Usage: pnpm uninstall-app <app-id>');
		process.exit(1);
	}

	if (!APP_ID_PATTERN.test(appId)) {
		console.error(`Invalid app ID "${appId}". Must be lowercase letters, numbers, and hyphens.`);
		process.exit(1);
	}

	if (PROTECTED_APPS.has(appId)) {
		console.error(`Cannot uninstall built-in app "${appId}".`);
		process.exit(1);
	}

	const appsDir = getAppsDir();
	const appDir = join(appsDir, appId);

	try {
		await stat(appDir);
	} catch {
		console.error(`App "${appId}" is not installed (${appDir} does not exist).`);
		process.exit(1);
	}

	await rm(appDir, { recursive: true, force: true });
	console.log(`App "${appId}" has been uninstalled.`);
	console.log('Restart PAS to apply the change.');
}

main().catch((err) => {
	console.error('Unexpected error:', err);
	process.exit(1);
});
