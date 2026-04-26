import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runUninstallAppCli } from '../uninstall-app.js';

function createCliDeps() {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		stdout,
		stderr,
		deps: {
			getAppsDir: () => '/tmp/apps',
			statPath: vi.fn(),
			removeDir: vi.fn(),
			stdout: (message: string) => stdout.push(message),
			stderr: (message: string) => stderr.push(message),
		},
	};
}

describe('uninstall-app CLI', () => {
	it('prints usage when app ID is missing', async () => {
		const { deps, stderr } = createCliDeps();

		const exitCode = await runUninstallAppCli([], deps);

		expect(exitCode).toBe(1);
		expect(stderr[0]).toContain('Usage: pnpm uninstall-app');
	});

	it('rejects invalid app IDs before touching the filesystem', async () => {
		const { deps, stderr } = createCliDeps();

		const exitCode = await runUninstallAppCli(['../evil'], deps);

		expect(exitCode).toBe(1);
		expect(stderr[0]).toContain('Invalid app ID');
		expect(deps.statPath).not.toHaveBeenCalled();
		expect(deps.removeDir).not.toHaveBeenCalled();
	});

	it('rejects protected built-in apps', async () => {
		const { deps, stderr } = createCliDeps();

		const exitCode = await runUninstallAppCli(['echo'], deps);

		expect(exitCode).toBe(1);
		expect(stderr[0]).toContain('Cannot uninstall built-in app "echo".');
		expect(deps.statPath).not.toHaveBeenCalled();
	});

	it('reports a missing app', async () => {
		const { deps, stderr } = createCliDeps();
		deps.statPath = vi.fn().mockRejectedValue(new Error('missing'));

		const exitCode = await runUninstallAppCli(['weather'], deps);

		expect(exitCode).toBe(1);
		expect(stderr[0]).toContain('App "weather" is not installed');
		expect(deps.removeDir).not.toHaveBeenCalled();
	});

	it('removes the app directory and prints restart guidance on success', async () => {
		const { deps, stdout } = createCliDeps();
		deps.statPath = vi.fn().mockResolvedValue({ isDirectory: () => true });
		deps.removeDir = vi.fn().mockResolvedValue(undefined);

		const exitCode = await runUninstallAppCli(['weather'], deps);

		expect(exitCode).toBe(0);
		expect(deps.removeDir).toHaveBeenCalledWith(join('/tmp/apps', 'weather'), {
			recursive: true,
			force: true,
		});
		expect(stdout[0]).toBe('App "weather" has been uninstalled.');
		expect(stdout[1]).toBe('Restart PAS to apply the change.');
	});

	it('returns an error when removing the app directory fails', async () => {
		const { deps, stderr } = createCliDeps();
		deps.statPath = vi.fn().mockResolvedValue({ isDirectory: () => true });
		deps.removeDir = vi.fn().mockRejectedValue(new Error('permission denied'));

		const exitCode = await runUninstallAppCli(['weather'], deps);

		expect(exitCode).toBe(1);
		expect(stderr[0]).toContain('Unexpected error: permission denied');
	});
});
