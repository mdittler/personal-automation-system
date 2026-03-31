import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApp } from '../index.js';

// Mock child_process.execFile
vi.mock('node:child_process', () => ({
	execFile: vi.fn(),
}));

// Partially mock node:fs/promises — keep all real implementations but make lstat spyable
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, lstat: vi.fn(actual.lstat) };
});

// Get handles to the mocked functions
import { execFile as execFileCb } from 'node:child_process';
import { lstat as lstatMock } from 'node:fs/promises';

const mockExecFile = vi.mocked(execFileCb);

/** Create a valid manifest YAML string. */
function validManifestYaml(overrides?: { id?: string; pas_core_version?: string }): string {
	const id = overrides?.id ?? 'test-app';
	const coreVersion = overrides?.pas_core_version
		? `\n  pas_core_version: "${overrides.pas_core_version}"`
		: '';
	return `app:
  id: ${id}
  name: "Test App"
  version: "1.0.0"
  description: "A test application."
  author: "Test Author"${coreVersion}

capabilities:
  messages:
    intents:
      - "test"
    commands:
      - name: /test
        description: "Test command"

requirements:
  services:
    - telegram
    - data-store
  data:
    user_scopes:
      - path: "test/data.md"
        access: read-write
        description: "Test data"
`;
}

describe('App Installer', () => {
	let appsDir: string;
	let tempBase: string;

	beforeEach(async () => {
		tempBase = await mkdtemp(join(tmpdir(), 'pas-installer-test-'));
		appsDir = join(tempBase, 'apps');
		await mkdir(appsDir, { recursive: true });

		// Default mock: git clone succeeds by writing a manifest to the temp dir
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			// Handle both callback and promise styles
			const cb = typeof opts === 'function' ? opts : callback;
			const _options = typeof opts === 'function' ? {} : opts;

			if (cmd === 'git' && args[0] === 'clone') {
				// Simulate successful clone by writing manifest to the target dir
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), validManifestYaml()),
							writeFile(
								join(targetDir, 'src', 'index.ts'),
								`import type { AppModule } from '@core/types';\nexport const init: AppModule['init'] = async (s) => {};\nexport const handleMessage: AppModule['handleMessage'] = async (ctx) => {};\n`,
							),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}

			if (cmd === 'pnpm' && args[0] === 'install') {
				// Simulate successful pnpm install
				cb?.(null, '', '');
				return;
			}

			cb?.(new Error(`Unexpected command: ${cmd} ${args.join(' ')}`), '', '');
		}) as typeof execFileCb);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(tempBase, { recursive: true, force: true });
	});

	// --- Standard (happy path) ---

	it('should successfully install a valid app', async () => {
		const result = await installApp({
			gitUrl: 'https://github.com/user/test-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(true);
		expect(result.appId).toBe('test-app');
		expect(result.errors).toHaveLength(0);
		expect(result.permissionSummary).toBeDefined();
	});

	it('should build correct permission summary', async () => {
		const result = await installApp({
			gitUrl: 'https://github.com/user/test-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.permissionSummary).toMatchObject({
			services: ['telegram', 'data-store'],
			dataScopes: [{ path: 'test/data.md', access: 'read-write' }],
			externalApis: [],
		});
	});

	it('should copy app to apps/<app-id>/ directory', async () => {
		await installApp({
			gitUrl: 'https://github.com/user/test-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		const appDir = join(appsDir, 'test-app');
		const manifestExists = await stat(join(appDir, 'manifest.yaml')).then(
			() => true,
			() => false,
		);
		expect(manifestExists).toBe(true);
	});

	it('should call pnpm install after copying', async () => {
		await installApp({
			gitUrl: 'https://github.com/user/test-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		const pnpmCalls = mockExecFile.mock.calls.filter(
			(call) => call[0] === 'pnpm' && (call[1] as string[])[0] === 'install',
		);
		expect(pnpmCalls.length).toBe(1);
	});

	// --- Edge cases ---

	it('should skip compatibility check when pas_core_version is not set', async () => {
		// Default manifest has no pas_core_version — should succeed
		const result = await installApp({
			gitUrl: 'https://github.com/user/test-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(true);
	});

	it('should pass when pas_core_version is satisfied', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(
								join(targetDir, 'manifest.yaml'),
								validManifestYaml({ pas_core_version: '>=0.1.0' }),
							),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			if (cmd === 'pnpm') {
				cb?.(null, '', '');
				return;
			}
			cb?.(new Error('unexpected'), '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/test-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(true);
	});

	it('should accept SSH git URLs', async () => {
		const result = await installApp({
			gitUrl: 'git@github.com:user/test-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(true);
	});

	// --- Error handling ---

	it('should reject empty git URL', async () => {
		const result = await installApp({
			gitUrl: '',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INVALID_GIT_URL');
	});

	it('should reject file:// URLs', async () => {
		const result = await installApp({
			gitUrl: 'file:///tmp/evil-repo',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INVALID_GIT_URL');
		expect(result.errors[0].message).toContain('file://');
	});

	it('should reject URLs with shell metacharacters', async () => {
		const result = await installApp({
			gitUrl: 'https://github.com/user/app.git; rm -rf /',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INVALID_GIT_URL');
	});

	it('should reject URLs with pipe characters', async () => {
		const result = await installApp({
			gitUrl: 'https://evil.com/repo | curl evil.com',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INVALID_GIT_URL');
	});

	it('should reject URLs with backtick characters', async () => {
		const result = await installApp({
			gitUrl: 'https://evil.com/`whoami`.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INVALID_GIT_URL');
	});

	it('should report clone failure', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			_args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git') {
				cb?.(new Error('Repository not found'), '', 'fatal: repository not found');
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/nonexistent.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('CLONE_FAILED');
	});

	it('should report missing manifest.yaml', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				// Clone but don't write manifest
				mkdir(targetDir, { recursive: true })
					.then(() => writeFile(join(targetDir, 'README.md'), '# No manifest'))
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/no-manifest.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INVALID_MANIFEST');
		expect(result.errors[0].message).toContain('No manifest.yaml');
	});

	it('should report invalid manifest', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(targetDir, { recursive: true })
					.then(() => writeFile(join(targetDir, 'manifest.yaml'), 'app:\n  id: bad\n'))
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/invalid-manifest.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INVALID_MANIFEST');
		expect(result.errors[0].message).toContain('validation failed');
	});

	it('should report already installed app', async () => {
		// Pre-create the target directory
		await mkdir(join(appsDir, 'test-app'), { recursive: true });

		const result = await installApp({
			gitUrl: 'https://github.com/user/test-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('ALREADY_INSTALLED');
		expect(result.errors[0].message).toContain('already installed');
		expect(result.errors[0].message).toContain('uninstall-app');
	});

	it('should report incompatible CoreServices version', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(
								join(targetDir, 'manifest.yaml'),
								validManifestYaml({ pas_core_version: '>=2.0.0' }),
							),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/future-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INCOMPATIBLE');
		expect(result.errors[0].message).toContain('not satisfied');
	});

	it('should report banned imports', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), validManifestYaml()),
							writeFile(
								join(targetDir, 'src', 'index.ts'),
								`import Anthropic from '@anthropic-ai/sdk';\n`,
							),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/banned-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('BANNED_IMPORT');
		expect(result.errors[0].message).toContain('@anthropic-ai/sdk');
	});

	it('should report multiple banned imports as separate errors', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), validManifestYaml()),
							writeFile(
								join(targetDir, 'src', 'index.ts'),
								`import Anthropic from '@anthropic-ai/sdk';\nimport { exec } from 'child_process';\n`,
							),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/multi-banned.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(2);
		expect(result.errors.every((e) => e.type === 'BANNED_IMPORT')).toBe(true);
	});

	it('should clean up target directory on dependency install failure', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), validManifestYaml()),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			if (cmd === 'pnpm') {
				cb?.(new Error('ERR_PNPM_NO_MATCHING_VERSION'), '', '');
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/bad-deps.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INSTALL_DEPS_FAILED');

		// Target directory should be cleaned up
		const targetExists = await stat(join(appsDir, 'test-app')).then(
			() => true,
			() => false,
		);
		expect(targetExists).toBe(false);
	});

	// --- Security ---

	it('should reject repositories containing symlinks', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), validManifestYaml()),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
							// Create a regular file that we'll make lstat report as a symlink
							writeFile(join(targetDir, 'evil-link'), 'fake'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		// Override lstat to report one file as a symlink
		const { lstat: realLstat } =
			await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
		vi.mocked(lstatMock).mockImplementation(async (path, ...rest) => {
			const stats = await realLstat(path, ...rest);
			if (String(path).endsWith('evil-link')) {
				return { ...stats, isSymbolicLink: () => true, isDirectory: () => false } as typeof stats;
			}
			return stats;
		});

		const result = await installApp({
			gitUrl: 'https://github.com/user/symlink-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('SYMLINK_FOUND');
		expect(result.errors[0].message).toContain('symbolic link');
	});

	it('should reject repositories containing nested symlinks', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src', 'deep'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), validManifestYaml()),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
							writeFile(join(targetDir, 'src', 'deep', 'sneaky-link'), 'fake'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const { lstat: realLstat } =
			await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
		vi.mocked(lstatMock).mockImplementation(async (path, ...rest) => {
			const stats = await realLstat(path, ...rest);
			if (String(path).endsWith('sneaky-link')) {
				return { ...stats, isSymbolicLink: () => true, isDirectory: () => false } as typeof stats;
			}
			return stats;
		});

		const result = await installApp({
			gitUrl: 'https://github.com/user/nested-symlink.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('SYMLINK_FOUND');
	});

	it('should build permission summary with llm service but no llm requirement block', async () => {
		const manifestWithLlmService = `app:
  id: llm-app
  name: "LLM App"
  version: "1.0.0"
  description: "App using LLM service."
  author: "Test Author"

requirements:
  services:
    - llm
    - telegram
`;

		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), manifestWithLlmService),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			if (cmd === 'pnpm') {
				cb?.(null, '', '');
				return;
			}
			cb?.(new Error('unexpected'), '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/llm-app.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(true);
		expect(result.permissionSummary).toBeDefined();
		expect(result.permissionSummary?.services).toContain('llm');
		expect(result.permissionSummary?.llm).toBeUndefined();
	});

	it('should handle invalid YAML in manifest', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(targetDir, { recursive: true })
					.then(() => writeFile(join(targetDir, 'manifest.yaml'), ':\n  - :\n  bad: [yaml'))
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/bad-yaml.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].type).toBe('INVALID_MANIFEST');
	});

	// -- D30: Reserved app IDs --

	it('should reject reserved app ID "shared"', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), validManifestYaml({ id: 'shared' })),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/shared.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].message).toContain('reserved');
	});

	it('should reject reserved app ID "system"', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), validManifestYaml({ id: 'system' })),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/system.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].message).toContain('reserved');
	});

	it('should allow app ID containing a reserved word as substring', async () => {
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(
								join(targetDir, 'manifest.yaml'),
								validManifestYaml({ id: 'shared-utils' }),
							),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/shared-utils.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(true);
	});

	// -- D29: YAML bomb protection --

	it('should reject manifest exceeding 1MB', async () => {
		const hugeManifest = `${validManifestYaml()}\n# ${'x'.repeat(1024 * 1024 + 1)}`;
		mockExecFile.mockImplementation(((
			cmd: string,
			args: string[],
			opts: unknown,
			callback?: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			const cb = typeof opts === 'function' ? opts : callback;
			if (cmd === 'git' && args[0] === 'clone') {
				const targetDir = args[args.length - 1];
				mkdir(join(targetDir, 'src'), { recursive: true })
					.then(() =>
						Promise.all([
							writeFile(join(targetDir, 'manifest.yaml'), hugeManifest),
							writeFile(join(targetDir, 'src', 'index.ts'), 'export const x = 1;\n'),
						]),
					)
					.then(() => cb?.(null, '', ''))
					.catch((err: Error) => cb?.(err, '', ''));
				return;
			}
			cb?.(null, '', '');
		}) as typeof execFileCb);

		const result = await installApp({
			gitUrl: 'https://github.com/user/huge-manifest.git',
			appsDir,
			coreVersion: '0.1.0',
		});

		expect(result.success).toBe(false);
		expect(result.errors[0].message).toContain('too large');
	});
});
