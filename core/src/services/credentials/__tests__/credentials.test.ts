import { mkdtemp, mkdir, readdirSync, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialService } from '../index.js';

let tmpDir: string;
let service: CredentialService;

async function writeSysFile(tmpDir: string, filename: string, content: string): Promise<string> {
	const dir = join(tmpDir, 'system');
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, filename);
	await writeFile(filePath, content, 'utf-8');
	return filePath;
}

beforeEach(async () => {
	const { tmpdir } = await import('node:os');
	tmpDir = await mkdtemp(join(tmpdir(), 'pas-credentials-test-'));
	service = new CredentialService({ dataDir: tmpDir });
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe('CredentialService', () => {
	// ---- 1. Hash round-trip ----
	it('setPassword + verifyPassword returns true', async () => {
		await service.setPassword('user1', 'my-secret');
		expect(await service.verifyPassword('user1', 'my-secret')).toBe(true);
	});

	// ---- 2. Wrong password ----
	it('verifyPassword returns false for wrong password', async () => {
		await service.setPassword('user1', 'correct');
		expect(await service.verifyPassword('user1', 'wrong')).toBe(false);
	});

	// ---- 3. Hash format versioning: unknown version is skipped ----
	it('skips entry with unknown version — verifyPassword returns false', async () => {
		await writeSysFile(
			tmpDir,
			'credentials.yaml',
			[
				'user1:',
				'  version: 99',
				'  algo: scrypt',
				'  salt: abc123',
				'  hash: def456',
				'  params:',
				'    N: 16384',
				'    r: 8',
				'    p: 1',
				'    keyLen: 64',
				'  sessionVersion: 5',
				'  updatedAt: "2026-01-01T00:00:00.000Z"',
			].join('\n'),
		);
		expect(await service.verifyPassword('user1', 'anything')).toBe(false);
		// sessionVersion also unreadable (entry skipped)
		expect(await service.getSessionVersion('user1')).toBe(0);
	});

	// ---- 4. sessionVersion monotonic ----
	it('incrementSessionVersion strictly increases', async () => {
		await service.setPassword('u', 'pw'); // sessionVersion = 1
		const v1 = await service.getSessionVersion('u');
		const v2 = await service.incrementSessionVersion('u');
		const v3 = await service.incrementSessionVersion('u');
		expect(v1).toBe(1);
		expect(v2).toBe(2);
		expect(v3).toBe(3);
	});

	// ---- 5. setPassword bumps sessionVersion each time ----
	it('setPassword bumps sessionVersion on each call', async () => {
		await service.setPassword('u', 'pw1'); // v1
		await service.setPassword('u', 'pw2'); // v2
		expect(await service.getSessionVersion('u')).toBe(2);
	});

	// ---- 6. First setPassword sets sessionVersion to exactly 1 ----
	it('first setPassword for a new user sets sessionVersion to 1, not undefined+1', async () => {
		await service.setPassword('newuser', 'pw');
		expect(await service.getSessionVersion('newuser')).toBe(1);
	});

	// ---- 7. getSessionVersion returns 0 for users with no credentials ----
	it('getSessionVersion returns 0 for unknown users', async () => {
		expect(await service.getSessionVersion('nobody')).toBe(0);
	});

	// ---- 8. clearCredentials ----
	it('clearCredentials makes verifyPassword return false', async () => {
		await service.setPassword('u', 'pw');
		await service.clearCredentials('u');
		expect(await service.verifyPassword('u', 'pw')).toBe(false);
		expect(await service.hasCredentials('u')).toBe(false);
	});

	// ---- 9. File parse/write round-trip ----
	it('data survives a restart (new CredentialService reads same file)', async () => {
		await service.setPassword('u1', 'alpha');
		await service.setPassword('u2', 'beta');

		const service2 = new CredentialService({ dataDir: tmpDir });
		expect(await service2.verifyPassword('u1', 'alpha')).toBe(true);
		expect(await service2.verifyPassword('u2', 'beta')).toBe(true);
		expect(await service2.verifyPassword('u1', 'beta')).toBe(false);
	});

	// ---- 10. Corrupt YAML → .corrupt sidecar ----
	it('corrupt YAML creates a .corrupt sidecar and starts empty', async () => {
		// Write content that is genuinely invalid YAML (unclosed bracket)
		await writeSysFile(tmpDir, 'credentials.yaml', 'user1: [unclosed bracket\n  bad:\n');

		// Trigger a load
		expect(await service.verifyPassword('nobody', 'pw')).toBe(false);

		// A .corrupt sidecar must exist in the system dir
		const { readdirSync: rd } = await import('node:fs');
		const sysFiles = rd(join(tmpDir, 'system'));
		const corruptFiles = sysFiles.filter((f) => f.endsWith('.corrupt'));
		expect(corruptFiles.length).toBeGreaterThanOrEqual(1);
	});

	// ---- 11. Concurrent writes are serialized ----
	it('concurrent setPassword calls for different users do not clobber each other', async () => {
		await Promise.all([
			service.setPassword('alice', 'alice-pw'),
			service.setPassword('bob', 'bob-pw'),
			service.setPassword('carol', 'carol-pw'),
		]);
		expect(await service.verifyPassword('alice', 'alice-pw')).toBe(true);
		expect(await service.verifyPassword('bob', 'bob-pw')).toBe(true);
		expect(await service.verifyPassword('carol', 'carol-pw')).toBe(true);
	});

	// ---- 12. hasCredentials ----
	it('hasCredentials returns false before setPassword and true after', async () => {
		expect(await service.hasCredentials('u')).toBe(false);
		await service.setPassword('u', 'pw');
		expect(await service.hasCredentials('u')).toBe(true);
	});
});
