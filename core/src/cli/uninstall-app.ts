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
const PROTECTED_APPS = new Set(['echo']);

export interface UninstallAppCliDeps {
	getAppsDir?: () => string;
	statPath?: typeof stat;
	removeDir?: typeof rm;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
}

function getAppsDir(): string {
	return resolve(join(__dirname, '..', '..', '..', 'apps'));
}

function defaultStdout(message: string): void {
	console.log(message);
}

function defaultStderr(message: string): void {
	console.error(message);
}

export async function runUninstallAppCli(
	args: string[],
	deps: UninstallAppCliDeps = {},
): Promise<number> {
	const stdout = deps.stdout ?? defaultStdout;
	const stderr = deps.stderr ?? defaultStderr;
	const appsDir = (deps.getAppsDir ?? getAppsDir)();
	const statPath = deps.statPath ?? stat;
	const removeDir = deps.removeDir ?? rm;
	const appId = args[0];

	if (!appId) {
		stderr('Usage: pnpm uninstall-app <app-id>');
		return 1;
	}

	if (!APP_ID_PATTERN.test(appId)) {
		stderr(`Invalid app ID "${appId}". Must be lowercase letters, numbers, and hyphens.`);
		return 1;
	}

	if (PROTECTED_APPS.has(appId)) {
		stderr(`Cannot uninstall built-in app "${appId}".`);
		return 1;
	}

	const appDir = join(appsDir, appId);
	try {
		await statPath(appDir);
	} catch {
		stderr(`App "${appId}" is not installed (${appDir} does not exist).`);
		return 1;
	}

	try {
		await removeDir(appDir, { recursive: true, force: true });
	} catch (err) {
		stderr(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	stdout(`App "${appId}" has been uninstalled.`);
	stdout('Restart PAS to apply the change.');
	return 0;
}

async function main(): Promise<void> {
	process.exitCode = await runUninstallAppCli(process.argv.slice(2));
}

const isDirectRun = process.argv[1]?.includes('uninstall-app');
if (isDirectRun) {
	main().catch((err) => {
		console.error('Unexpected error:', err);
		process.exit(1);
	});
}
