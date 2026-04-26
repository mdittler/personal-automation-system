import { describe, expect, it, vi } from 'vitest';
import type {
	InstallError,
	InstallResult,
	PermissionSummary,
	PlanInstallResult,
	PreparedInstall,
} from '../../services/app-installer/index.js';
import { parseYesFlag, runInstallAppCli } from '../install-app.js';

function createPermissionSummary(): PermissionSummary {
	return {
		services: ['telegram', 'data-store'],
		dataScopes: [{ path: 'log.md', access: 'read-write' }],
		externalApis: [],
	};
}

function createPreparedInstall(
	overrides?: Partial<PreparedInstall>,
): PreparedInstall & {
	commitMock: ReturnType<typeof vi.fn>;
	disposeMock: ReturnType<typeof vi.fn>;
} {
	const commitMock = vi.fn<PreparedInstall['commit']>().mockResolvedValue({
		success: true,
		appId: 'test-app',
		errors: [],
		permissionSummary: createPermissionSummary(),
	} satisfies InstallResult);
	const disposeMock = vi.fn<PreparedInstall['dispose']>().mockResolvedValue(undefined);

	return {
		appId: 'test-app',
		permissionSummary: createPermissionSummary(),
		commit: commitMock,
		dispose: disposeMock,
		...overrides,
		commitMock,
		disposeMock,
	};
}

function createCliDeps(overrides?: {
	planInstall?: () => Promise<PlanInstallResult>;
	prompt?: (question: string) => Promise<string>;
}) {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		stdout,
		stderr,
		deps: {
			getCoreVersion: () => '0.1.0',
			getAppsDir: () => '/tmp/apps',
			planInstall: overrides?.planInstall,
			prompt: overrides?.prompt,
			stdout: (message: string) => stdout.push(message),
			stderr: (message: string) => stderr.push(message),
		},
	};
}

describe('install-app CLI', () => {
	describe('parseYesFlag', () => {
		it('returns true when --yes is present', () => {
			expect(parseYesFlag(['https://github.com/user/repo.git', '--yes'])).toBe(true);
		});

		it('returns true when -y is present', () => {
			expect(parseYesFlag(['-y', 'https://github.com/user/repo.git'])).toBe(true);
		});

		it('returns false when neither flag is present', () => {
			expect(parseYesFlag(['https://github.com/user/repo.git'])).toBe(false);
		});
	});

	it('prints usage when git URL is missing', async () => {
		const { deps, stderr } = createCliDeps();

		const exitCode = await runInstallAppCli([], deps);

		expect(exitCode).toBe(1);
		expect(stderr[0]).toContain('Usage: pnpm install-app');
	});

	it('prints the permission summary before prompting and cancels cleanly', async () => {
		const prepared = createPreparedInstall();
		const prompt = vi.fn().mockResolvedValue('n');
		const { deps, stdout } = createCliDeps({
			planInstall: async () => ({
				success: true,
				appId: prepared.appId,
				errors: [],
				permissionSummary: prepared.permissionSummary,
				preparedInstall: prepared,
			}),
			prompt,
		});

		const exitCode = await runInstallAppCli(['https://github.com/user/repo.git'], deps);

		expect(exitCode).toBe(0);
		expect(prompt).toHaveBeenCalledOnce();
		expect(prepared.commitMock).not.toHaveBeenCalled();
		expect(prepared.disposeMock).toHaveBeenCalledOnce();
		expect(stdout).toContain('Permission Summary:');
		expect(stdout.at(-1)).toBe('Installation cancelled.');
	});

	it('prints the permission summary before commit on approval', async () => {
		const order: string[] = [];
		const prepared = createPreparedInstall({
			commit: vi.fn(async () => {
				order.push('commit');
				return {
					success: true,
					appId: 'test-app',
					errors: [],
					permissionSummary: createPermissionSummary(),
				};
			}),
		});
		const prompt = vi.fn(async () => 'y');
		const { deps } = createCliDeps({
			planInstall: async () => ({
				success: true,
				appId: prepared.appId,
				errors: [],
				permissionSummary: prepared.permissionSummary,
				preparedInstall: prepared,
			}),
			prompt,
		});
		deps.stdout = (message: string) => order.push(`out:${message}`);

		const exitCode = await runInstallAppCli(['https://github.com/user/repo.git'], deps);

		expect(exitCode).toBe(0);
		expect(prompt).toHaveBeenCalledOnce();
		expect(order.indexOf('out:Permission Summary:')).toBeGreaterThan(-1);
		expect(order.indexOf('out:Permission Summary:')).toBeLessThan(order.indexOf('commit'));
		expect(prepared.disposeMock).toHaveBeenCalledOnce();
	});

	it('prints the permission summary and skips the prompt with --yes', async () => {
		const prepared = createPreparedInstall();
		const prompt = vi.fn();
		const { deps, stdout } = createCliDeps({
			planInstall: async () => ({
				success: true,
				appId: prepared.appId,
				errors: [],
				permissionSummary: prepared.permissionSummary,
				preparedInstall: prepared,
			}),
			prompt,
		});

		const exitCode = await runInstallAppCli(
			['https://github.com/user/repo.git', '--yes'],
			deps,
		);

		expect(exitCode).toBe(0);
		expect(prompt).not.toHaveBeenCalled();
		expect(prepared.commitMock).toHaveBeenCalledOnce();
		expect(stdout).toContain('Permission Summary:');
	});

	it('prints planner failures without prompting or committing', async () => {
		const prompt = vi.fn();
		const plannerErrors: InstallError[] = [
			{ type: 'INVALID_GIT_URL', message: 'Git URL contains invalid characters.' },
		];
		const { deps, stderr } = createCliDeps({
			planInstall: async () => ({
				success: false,
				errors: plannerErrors,
			}),
			prompt,
		});

		const exitCode = await runInstallAppCli(['https://bad.example/repo.git'], deps);

		expect(exitCode).toBe(1);
		expect(prompt).not.toHaveBeenCalled();
		expect(stderr.join('\n')).toContain('[INVALID_GIT_URL] Git URL contains invalid characters.');
	});

	it('reports commit failures and still disposes the prepared install', async () => {
		const prepared = createPreparedInstall({
			commit: vi.fn(async () => ({
				success: false,
				appId: 'test-app',
				errors: [{ type: 'INSTALL_DEPS_FAILED', message: 'Failed to install dependencies.' }],
				permissionSummary: createPermissionSummary(),
			})),
		});
		const { deps, stderr } = createCliDeps({
			planInstall: async () => ({
				success: true,
				appId: prepared.appId,
				errors: [],
				permissionSummary: prepared.permissionSummary,
				preparedInstall: prepared,
			}),
			prompt: async () => 'y',
		});

		const exitCode = await runInstallAppCli(['https://github.com/user/repo.git'], deps);

		expect(exitCode).toBe(1);
		expect(stderr.join('\n')).toContain('[INSTALL_DEPS_FAILED] Failed to install dependencies.');
		expect(prepared.disposeMock).toHaveBeenCalledOnce();
	});

	it('still disposes the prepared install when commit throws unexpectedly', async () => {
		const prepared = createPreparedInstall({
			commit: vi.fn(async () => {
				throw new Error('commit boom');
			}),
		});
		const { deps, stderr } = createCliDeps({
			planInstall: async () => ({
				success: true,
				appId: prepared.appId,
				errors: [],
				permissionSummary: prepared.permissionSummary,
				preparedInstall: prepared,
			}),
			prompt: async () => 'y',
		});

		const exitCode = await runInstallAppCli(['https://github.com/user/repo.git'], deps);

		expect(exitCode).toBe(1);
		expect(stderr.at(-1)).toContain('Unexpected error: commit boom');
		expect(prepared.disposeMock).toHaveBeenCalledOnce();
	});
});
