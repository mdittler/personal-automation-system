#!/usr/bin/env node
/**
 * CLI entry point for installing a PAS app from a git URL.
 *
 * Usage: pnpm install-app <git-url> [--yes]
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installApp } from '../services/app-installer/index.js';
import type { InstallResult, PermissionSummary } from '../services/app-installer/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getCoreVersion(): string {
	const pkgPath = join(__dirname, '..', '..', 'package.json');
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
	return pkg.version;
}

function getAppsDir(): string {
	return resolve(join(__dirname, '..', '..', '..', 'apps'));
}

function formatPermissions(summary: PermissionSummary): string {
	const lines: string[] = ['', 'Permission Summary:'];

	if (summary.services.length > 0) {
		lines.push(`  Services: ${summary.services.join(', ')}`);
	}

	if (summary.dataScopes.length > 0) {
		lines.push('  Data access:');
		for (const scope of summary.dataScopes) {
			lines.push(`    - ${scope.path} (${scope.access})`);
		}
	}

	if (summary.externalApis.length > 0) {
		lines.push('  External APIs:');
		for (const api of summary.externalApis) {
			lines.push(`    - ${api.id} [${api.envVar}] (${api.required ? 'required' : 'optional'})`);
		}
	}

	if (summary.llm) {
		const parts: string[] = [];
		if (summary.llm.tier) parts.push(`tier: ${summary.llm.tier}`);
		if (summary.llm.costCap) parts.push(`cost cap: $${summary.llm.costCap}/month`);
		if (parts.length > 0) {
			lines.push(`  LLM: ${parts.join(', ')}`);
		}
	}

	return lines.join('\n');
}

function formatErrors(result: InstallResult, appName?: string): string {
	const lines: string[] = [];
	const label = appName ? `"${appName}"` : 'app';
	lines.push(`\nERROR: ${label} failed validation:\n`);

	for (const err of result.errors) {
		lines.push(`  [${err.type}] ${err.message}`);
		if (err.details) {
			for (const detail of err.details.split('\n')) {
				lines.push(`    ${detail}`);
			}
		}
	}

	lines.push('\nInstall cancelled. Fix the issues above and try again.');
	return lines.join('\n');
}

async function main() {
	const args = process.argv.slice(2);
	const gitUrl = args.find((a) => !a.startsWith('-'));

	if (!gitUrl) {
		console.error('Usage: pnpm install-app <git-url> [--yes]');
		console.error('');
		console.error('Options:');
		console.error('  --yes, -y    Skip confirmation prompt');
		process.exit(1);
	}

	const coreVersion = getCoreVersion();
	const appsDir = getAppsDir();

	console.log(`Installing app from ${gitUrl}...`);
	console.log(`CoreServices version: ${coreVersion}`);
	console.log('');

	// First pass: validate only (don't install deps yet)
	// We do the full install in one shot since installApp handles the pipeline
	const result = await installApp({ gitUrl, appsDir, coreVersion });

	if (!result.success) {
		console.error(formatErrors(result));
		process.exit(1);
	}

	if (result.permissionSummary) {
		console.log(formatPermissions(result.permissionSummary));
	}

	console.log(`\nApp "${result.appId}" installed successfully.`);
	console.log('Restart PAS to load the new app.');
}

main().catch((err) => {
	console.error('Unexpected error:', err);
	process.exit(1);
});
