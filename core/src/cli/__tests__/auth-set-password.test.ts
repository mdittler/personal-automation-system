import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialService } from '../../services/credentials/index.js';
import { runAuthSetPasswordCli } from '../auth-set-password.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-auth-set-password-test-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('auth:set-password CLI', () => {
	it('prints usage when user id is missing', async () => {
		const stderr = vi.fn();

		const exitCode = await runAuthSetPasswordCli([], {
			stdout: vi.fn(),
			stderr,
		});

		expect(exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Usage: pnpm auth:set-password'));
	});

	it('sets a password for an existing config user through CredentialService', async () => {
		const credentialService = new CredentialService({ dataDir: tempDir });
		const stdout = vi.fn();
		const stderr = vi.fn();

		const exitCode = await runAuthSetPasswordCli(
			['--user-id', '8187111554', '--data-dir', tempDir],
			{
				credentialService,
				readConfig: async () => ({
					users: [{ id: '8187111554', name: 'Matthew', is_admin: true }],
				}),
				promptSecret: vi
					.fn()
					.mockResolvedValueOnce('new-password')
					.mockResolvedValueOnce('new-password'),
				stdout,
				stderr,
			},
		);

		expect(exitCode).toBe(0);
		expect(stderr).not.toHaveBeenCalled();
		expect(await credentialService.verifyPassword('8187111554', 'new-password')).toBe(true);
		expect(stdout).toHaveBeenCalledWith('Password set for user 8187111554.');
	});

	it('rejects unknown users without writing credentials', async () => {
		const credentialService = new CredentialService({ dataDir: tempDir });
		const stderr = vi.fn();

		const exitCode = await runAuthSetPasswordCli(
			['--user-id', 'missing-user', '--data-dir', tempDir],
			{
				credentialService,
				readConfig: async () => ({
					users: [{ id: '8187111554', name: 'Matthew', is_admin: true }],
				}),
				promptSecret: vi.fn(),
				stdout: vi.fn(),
				stderr,
			},
		);

		expect(exitCode).toBe(1);
		expect(await credentialService.hasCredentials('missing-user')).toBe(false);
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining('was not found'));
	});

	it('rejects mismatched confirmation passwords', async () => {
		const credentialService = new CredentialService({ dataDir: tempDir });
		const stderr = vi.fn();

		const exitCode = await runAuthSetPasswordCli(
			['--user-id', '8187111554', '--data-dir', tempDir],
			{
				credentialService,
				readConfig: async () => ({
					users: [{ id: '8187111554', name: 'Matthew', is_admin: true }],
				}),
				promptSecret: vi
					.fn()
					.mockResolvedValueOnce('new-password')
					.mockResolvedValueOnce('different'),
				stdout: vi.fn(),
				stderr,
			},
		);

		expect(exitCode).toBe(1);
		expect(await credentialService.hasCredentials('8187111554')).toBe(false);
		expect(stderr).toHaveBeenCalledWith('Passwords do not match.');
	});
});
