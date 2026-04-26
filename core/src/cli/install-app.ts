#!/usr/bin/env node
/**
 * CLI entry point for installing a PAS app from a git URL.
 *
 * Usage: pnpm install-app <git-url> [--yes]
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
	planInstallApp,
	type InstallError,
	type PermissionSummary,
	type PlanInstallResult,
} from '../services/app-installer/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface InstallAppCliDeps {
	getCoreVersion?: () => string;
	getAppsDir?: () => string;
	planInstall?: (options: {
		gitUrl: string;
		appsDir: string;
		coreVersion: string;
	}) => Promise<PlanInstallResult>;
	prompt?: (question: string) => Promise<string>;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
}

function getCoreVersion(): string {
	const pkgPath = join(__dirname, '..', '..', 'package.json');
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
	return pkg.version;
}

function getAppsDir(): string {
	return resolve(join(__dirname, '..', '..', '..', 'apps'));
}

function createPrompt(): (question: string) => Promise<string> {
	return async (question: string) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			return await rl.question(question);
		} finally {
			rl.close();
		}
	};
}

function defaultStdout(message: string): void {
	console.log(message);
}

function defaultStderr(message: string): void {
	console.error(message);
}

function formatPermissions(summary: PermissionSummary): string[] {
	const lines: string[] = ['Permission Summary:'];

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

	return lines;
}

function formatErrors(errors: InstallError[], appName?: string): string[] {
	const lines: string[] = [];
	const label = appName ? `"${appName}"` : 'app';
	lines.push(`ERROR: ${label} failed validation:`);
	lines.push('');

	for (const err of errors) {
		lines.push(`  [${err.type}] ${err.message}`);
		if (err.details) {
			for (const detail of err.details.split('\n')) {
				lines.push(`    ${detail}`);
			}
		}
	}

	lines.push('');
	lines.push('Install cancelled. Fix the issues above and try again.');
	return lines;
}

/**
 * Exported for testing: parses the --yes / -y flag from an args array.
 */
export function parseYesFlag(args: string[]): boolean {
	return args.includes('--yes') || args.includes('-y');
}

export async function runInstallAppCli(
	args: string[],
	deps: InstallAppCliDeps = {},
): Promise<number> {
	const stdout = deps.stdout ?? defaultStdout;
	const stderr = deps.stderr ?? defaultStderr;
	const gitUrl = args.find((arg) => !arg.startsWith('-'));

	if (!gitUrl) {
		stderr('Usage: pnpm install-app <git-url> [--yes]');
		stderr('');
		stderr('Options:');
		stderr('  --yes, -y    Skip confirmation prompt');
		return 1;
	}

	const skipConfirm = parseYesFlag(args);
	const getCoreVersionValue = deps.getCoreVersion ?? getCoreVersion;
	const getAppsDirValue = deps.getAppsDir ?? getAppsDir;
	const planInstall = deps.planInstall ?? planInstallApp;
	const prompt = deps.prompt ?? createPrompt();
	const coreVersion = getCoreVersionValue();
	const appsDir = getAppsDirValue();

	stdout(`About to install app from: ${gitUrl}`);
	stdout(`CoreServices version: ${coreVersion}`);
	stdout('');
	stdout('The app will be cloned, validated, and its dependencies installed.');
	stdout('PAS will need to be restarted to load the new app.');
	stdout('');

	const planned = await planInstall({
		gitUrl,
		appsDir,
		coreVersion,
	});

	if (!planned.success || !planned.preparedInstall) {
		for (const line of formatErrors(planned.errors, planned.appId)) {
			stderr(line);
		}
		return 1;
	}

	const prepared = planned.preparedInstall;
	try {
		for (const line of formatPermissions(prepared.permissionSummary)) {
			stdout(line);
		}
		stdout('');

		if (!skipConfirm) {
			const answer = await prompt('Proceed with installation? [y/N] ');
			if (answer.trim().toLowerCase() !== 'y') {
				stdout('Installation cancelled.');
				return 0;
			}
		}

		const result = await prepared.commit();
		if (!result.success) {
			for (const line of formatErrors(result.errors, result.appId ?? prepared.appId)) {
				stderr(line);
			}
			return 1;
		}

		stdout(`App "${prepared.appId}" installed successfully.`);
		stdout('Restart PAS to load the new app.');
		return 0;
	} catch (err) {
		stderr(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	} finally {
		await prepared.dispose();
	}
}

async function main(): Promise<void> {
	process.exitCode = await runInstallAppCli(process.argv.slice(2));
}

const isDirectRun = process.argv[1]?.includes('install-app');
if (isDirectRun) {
	main().catch((err) => {
		console.error('Unexpected error:', err);
		process.exit(1);
	});
}
