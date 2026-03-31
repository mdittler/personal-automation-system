#!/usr/bin/env node
/**
 * CLI entry point for scaffolding a new PAS app.
 *
 * Usage: pnpm scaffold-app --name=<app-id> [--description=<text>] [--author=<name>]
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const RESERVED_NAMES = ['shared', 'system', 'core', 'pas', 'internal'];

interface ScaffoldOptions {
	name: string;
	description: string;
	author: string;
}

function parseArgs(argv: string[]): ScaffoldOptions | null {
	let name = '';
	let description = '';
	let author = '';

	for (const arg of argv) {
		if (arg.startsWith('--name=')) {
			name = arg.slice('--name='.length);
		} else if (arg.startsWith('--description=')) {
			description = arg.slice('--description='.length);
		} else if (arg.startsWith('--author=')) {
			author = arg.slice('--author='.length);
		}
	}

	if (!name) return null;
	return {
		name,
		description: description || 'A PAS app.',
		author: author || 'PAS Developer',
	};
}

function toDisplayName(appId: string): string {
	return appId
		.split('-')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

function toCommandName(appId: string): string {
	return appId.replace(/-/g, '_');
}

function replacePlaceholders(content: string, opts: ScaffoldOptions): string {
	return content
		.replace(/\{\{APP_ID\}\}/g, opts.name)
		.replace(/\{\{APP_COMMAND\}\}/g, toCommandName(opts.name))
		.replace(/\{\{APP_NAME\}\}/g, toDisplayName(opts.name))
		.replace(/\{\{APP_DESCRIPTION\}\}/g, opts.description)
		.replace(/\{\{AUTHOR\}\}/g, opts.author);
}

function getAppsDir(): string {
	return resolve(join(__dirname, '..', '..', '..', 'apps'));
}

function getTemplateDir(): string {
	return resolve(join(__dirname, 'templates', 'app'));
}

export interface ScaffoldResult {
	success: boolean;
	appDir?: string;
	error?: string;
}

export async function scaffoldApp(
	opts: ScaffoldOptions,
	appsDir?: string,
): Promise<ScaffoldResult> {
	if (!APP_ID_PATTERN.test(opts.name)) {
		return {
			success: false,
			error: `Invalid app name "${opts.name}". Must match ${APP_ID_PATTERN} (lowercase letters, numbers, hyphens; must start with a letter).`,
		};
	}

	if (RESERVED_NAMES.includes(opts.name)) {
		return {
			success: false,
			error: `"${opts.name}" is a reserved name and cannot be used as an app ID.`,
		};
	}

	const targetAppsDir = appsDir ?? getAppsDir();
	const appDir = join(targetAppsDir, opts.name);

	if (existsSync(appDir)) {
		return {
			success: false,
			error: `Directory already exists: ${appDir}`,
		};
	}

	const templateDir = getTemplateDir();
	const templateFiles = [
		'manifest.yaml',
		'package.json',
		'tsconfig.json',
		'help.md',
		'src/index.ts',
		'src/__tests__/app.test.ts',
		'docs/urs.md',
		'docs/requirements.md',
	];

	// Create app directory structure
	await mkdir(join(appDir, 'src', '__tests__'), { recursive: true });
	await mkdir(join(appDir, 'docs'), { recursive: true });

	// Copy and transform template files
	for (const file of templateFiles) {
		const srcPath = join(templateDir, file);
		const destPath = join(appDir, file);
		const content = await readFile(srcPath, 'utf-8');
		const transformed = replacePlaceholders(content, opts);
		await writeFile(destPath, transformed, 'utf-8');
	}

	return { success: true, appDir };
}

async function main() {
	const args = process.argv.slice(2);
	const opts = parseArgs(args);

	if (!opts) {
		console.error(
			'Usage: pnpm scaffold-app --name=<app-id> [--description=<text>] [--author=<name>]',
		);
		console.error('');
		console.error('Options:');
		console.error(
			'  --name         App ID (required). Lowercase, hyphens allowed, starts with letter.',
		);
		console.error('  --description  App description (default: "A PAS app.")');
		console.error('  --author       Author name (default: "PAS Developer")');
		process.exit(1);
	}

	const result = await scaffoldApp(opts);

	if (!result.success) {
		console.error(`ERROR: ${result.error}`);
		process.exit(1);
	}

	console.log(`App "${opts.name}" scaffolded at ${result.appDir}`);
	console.log('');
	console.log('Next steps:');
	console.log(`  1. Add your requirements to apps/${opts.name}/docs/requirements.md`);
	console.log(`  2. Formalize requirements into apps/${opts.name}/docs/urs.md`);
	console.log(`  3. Edit apps/${opts.name}/manifest.yaml to add intents and commands`);
	console.log(`  4. Implement your app in apps/${opts.name}/src/index.ts`);
	console.log('  5. Run `pnpm install` from the workspace root to link dependencies');
	console.log('  6. Run `pnpm build` to compile');
	console.log('  7. Run `pnpm test` to verify');
}

// Only run when executed directly (not imported for testing)
const isDirectRun = process.argv[1]?.includes('scaffold-app');
if (isDirectRun) {
	main().catch((err) => {
		console.error('Unexpected error:', err);
		process.exit(1);
	});
}
