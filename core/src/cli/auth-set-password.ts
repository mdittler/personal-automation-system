#!/usr/bin/env node
/**
 * Recovery CLI for setting a PAS GUI password without a working GUI session.
 *
 * Usage:
 *   pnpm auth:set-password --user-id <telegram-id>
 */

import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { config as loadDotenv } from 'dotenv';
import { CredentialService } from '../services/credentials/index.js';
import { readYamlFileStrict } from '../utils/yaml.js';

const MIN_PASSWORD_LENGTH = 8;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

interface AuthSetPasswordOptions {
	userId: string;
	configPath: string;
	dataDir: string;
}

interface PasYamlUser {
	id?: unknown;
}

interface PasYamlShape {
	users?: PasYamlUser[];
}

export interface AuthSetPasswordCliDeps {
	promptSecret?: (question: string) => Promise<string>;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
	credentialService?: Pick<CredentialService, 'setPassword' | 'verifyPassword'>;
	readConfig?: (configPath: string) => Promise<unknown>;
}

function defaultStdout(message: string): void {
	console.log(message);
}

function defaultStderr(message: string): void {
	console.error(message);
}

function parseArgValue(args: string[], name: string): string | undefined {
	const prefix = `${name}=`;
	const inline = args.find((arg) => arg.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);

	const index = args.indexOf(name);
	if (index >= 0) {
		return args[index + 1];
	}

	return undefined;
}

function parseOptions(args: string[]): AuthSetPasswordOptions | null {
	const userId = parseArgValue(args, '--user-id')?.trim() ?? '';
	if (!userId) return null;

	const envPath = resolve(parseArgValue(args, '--env-path') ?? '.env');
	loadDotenv({ path: envPath, quiet: true });

	return {
		userId,
		configPath: resolve(parseArgValue(args, '--config') ?? 'config/pas.yaml'),
		dataDir: resolve(parseArgValue(args, '--data-dir') ?? process.env.DATA_DIR ?? './data'),
	};
}

function usage(): string[] {
	return [
		'Usage: pnpm auth:set-password --user-id <telegram-id> [--config config/pas.yaml] [--data-dir data]',
		'',
		'Sets a PAS GUI password for an existing user without requiring a working GUI session.',
	];
}

async function defaultReadConfig(configPath: string): Promise<unknown> {
	const result = await readYamlFileStrict(configPath);
	if (result === null) {
		throw new Error(`Config file not found: ${configPath}`);
	}
	if ('error' in result) {
		throw new Error(result.error);
	}
	return result.data;
}

function getUserIds(config: unknown): Set<string> {
	if (typeof config !== 'object' || config === null || Array.isArray(config)) {
		return new Set();
	}

	const users = (config as PasYamlShape).users;
	if (!Array.isArray(users)) {
		return new Set();
	}

	return new Set(
		users.flatMap((user) => (typeof user.id === 'string' && user.id ? [user.id] : [])),
	);
}

async function promptPassword(
	promptSecret: (question: string) => Promise<string>,
): Promise<string> {
	const password = await promptSecret('New GUI password: ');
	const confirmation = await promptSecret('Confirm GUI password: ');

	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH.toString()} characters.`);
	}
	if (password !== confirmation) {
		throw new Error('Passwords do not match.');
	}
	return password;
}

async function defaultPromptSecret(question: string): Promise<string> {
	const rl = createInterface({ input, output });
	output.write(question);
	const mutable = rl as unknown as {
		_writeToOutput?: (stringToWrite: string) => void;
	};
	const originalWrite = mutable._writeToOutput?.bind(rl);
	mutable._writeToOutput = (stringToWrite: string) => {
		if (stringToWrite.includes('\n') || stringToWrite.includes('\r')) {
			originalWrite?.(stringToWrite);
		}
	};

	try {
		const answer = await rl.question('');
		output.write('\n');
		return answer;
	} finally {
		rl.close();
	}
}

export async function runAuthSetPasswordCli(
	args: string[],
	deps: AuthSetPasswordCliDeps = {},
): Promise<number> {
	const stdout = deps.stdout ?? defaultStdout;
	const stderr = deps.stderr ?? defaultStderr;
	const options = parseOptions(args);

	if (!options) {
		for (const line of usage()) stderr(line);
		return 1;
	}

	if (!USER_ID_PATTERN.test(options.userId)) {
		stderr('User ID may contain only letters, numbers, underscores, and hyphens.');
		return 1;
	}

	const readConfig = deps.readConfig ?? defaultReadConfig;
	const config = await readConfig(options.configPath);
	const userIds = getUserIds(config);
	if (!userIds.has(options.userId)) {
		stderr(`User "${options.userId}" was not found in ${options.configPath}.`);
		return 1;
	}

	try {
		const password = await promptPassword(deps.promptSecret ?? defaultPromptSecret);
		const credentialService =
			deps.credentialService ?? new CredentialService({ dataDir: options.dataDir });
		await credentialService.setPassword(options.userId, password);

		if (!(await credentialService.verifyPassword(options.userId, password))) {
			throw new Error('Password verification failed after writing credentials.');
		}

		stdout(`Password set for user ${options.userId}.`);
		stdout(`Credentials updated at ${resolve(options.dataDir, 'system', 'credentials.yaml')}.`);
		return 0;
	} catch (err) {
		stderr(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

const isDirectRun = process.argv[1]?.includes('auth-set-password');
if (isDirectRun) {
	runAuthSetPasswordCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((err) => {
			console.error('Unexpected error:', err);
			process.exit(1);
		});
}
