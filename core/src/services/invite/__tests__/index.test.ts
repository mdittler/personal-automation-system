import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InviteService } from '../index.js';

const logger = pino({ level: 'silent' });

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-invite-service-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeService(): InviteService {
	return new InviteService({ dataDir: tempDir, logger });
}

describe('InviteService', () => {
	// --- createInvite ---

	describe('createInvite', () => {
		it('returns an 8-character hex code', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			expect(code).toMatch(/^[0-9a-f]{8}$/);
		});

		it('stores the invite in the YAML file', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			const content = await readFile(join(tempDir, 'system', 'invites.yaml'), 'utf-8');
			expect(content).toContain(code);
			expect(content).toContain('Alice');
			expect(content).toContain('admin');
		});

		it('sets usedBy and usedAt to null', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			const store = await svc.listInvites();
			const invite = store[code];
			expect(invite).toBeDefined();
			expect(invite?.usedBy).toBeNull();
			expect(invite?.usedAt).toBeNull();
		});

		it('sets expiresAt 24 hours from now', async () => {
			const before = Date.now();
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			const after = Date.now();

			const store = await svc.listInvites();
			const invite = store[code];
			expect(invite).toBeDefined();

			const expiresAt = new Date(invite?.expiresAt ?? '').getTime();
			const expectedMin = before + 24 * 60 * 60 * 1000;
			const expectedMax = after + 24 * 60 * 60 * 1000;
			expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
			expect(expiresAt).toBeLessThanOrEqual(expectedMax);
		});

		it('stores createdAt as ISO string', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Bob', 'admin');

			const store = await svc.listInvites();
			const invite = store[code];
			expect(invite?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it('generates unique codes for multiple invites', async () => {
			const svc = makeService();
			const codes = await Promise.all([
				svc.createInvite('Alice', 'admin'),
				svc.createInvite('Bob', 'admin'),
				svc.createInvite('Charlie', 'admin'),
			]);

			const unique = new Set(codes);
			expect(unique.size).toBe(3);
		});

		it('persists multiple invites without overwriting', async () => {
			const svc = makeService();
			const code1 = await svc.createInvite('Alice', 'admin');
			const code2 = await svc.createInvite('Bob', 'admin');

			const store = await svc.listInvites();
			expect(store[code1]).toBeDefined();
			expect(store[code2]).toBeDefined();
		});
	});

	// --- validateCode ---

	describe('validateCode', () => {
		it('returns invite for a valid, unused, non-expired code', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			const result = await svc.validateCode(code);
			expect('invite' in result).toBe(true);
			if ('invite' in result) {
				expect(result.invite.name).toBe('Alice');
			}
		});

		it('returns error for a non-existent code', async () => {
			const svc = makeService();

			const result = await svc.validateCode('deadbeef');
			expect('error' in result).toBe(true);
			if ('error' in result) {
				expect(result.error).toBe('Invalid invite code.');
			}
		});

		it('returns error for an already-used code', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			await svc.redeemCode(code, 'user123');

			const result = await svc.validateCode(code);
			expect('error' in result).toBe(true);
			if ('error' in result) {
				expect(result.error).toBe('This invite code has already been used.');
			}
		});

		it('returns error for an expired code', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			// Manually expire the code by modifying the store
			const store = await svc.listInvites();
			const invite = store[code];
			if (invite) {
				invite.expiresAt = new Date(Date.now() - 1000).toISOString();
			}
			const { writeYamlFile } = await import('../../../utils/yaml.js');
			const { join: pathJoin } = await import('node:path');
			await writeYamlFile(pathJoin(tempDir, 'system', 'invites.yaml'), store);

			const result = await svc.validateCode(code);
			expect('error' in result).toBe(true);
			if ('error' in result) {
				expect(result.error).toBe('This invite code has expired. Ask the admin for a new one.');
			}
		});

		it('validates after reload (reads from disk)', async () => {
			const svc1 = makeService();
			const code = await svc1.createInvite('Alice', 'admin');

			// Create a fresh service instance — it should read from disk
			const svc2 = makeService();
			const result = await svc2.validateCode(code);
			expect('invite' in result).toBe(true);
		});
	});

	// --- redeemCode ---

	describe('redeemCode', () => {
		it('marks code as used', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			await svc.redeemCode(code, 'user123');

			const store = await svc.listInvites();
			const invite = store[code];
			expect(invite?.usedBy).toBe('user123');
			expect(invite?.usedAt).not.toBeNull();
		});

		it('sets usedAt as ISO string', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			await svc.redeemCode(code, 'user123');

			const store = await svc.listInvites();
			expect(store[code]?.usedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it('persists redemption to disk', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			await svc.redeemCode(code, 'user123');

			const content = await readFile(join(tempDir, 'system', 'invites.yaml'), 'utf-8');
			expect(content).toContain('user123');
		});

		it('reloads from disk for fresh service instance', async () => {
			const svc1 = makeService();
			const code = await svc1.createInvite('Alice', 'admin');
			await svc1.redeemCode(code, 'user123');

			const svc2 = makeService();
			const store = await svc2.listInvites();
			expect(store[code]?.usedBy).toBe('user123');
		});

		it('rejects already-used codes', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			await svc.redeemCode(code, 'user123');

			await expect(svc.redeemCode(code, 'user456')).rejects.toThrow('already used');
		});

		it('rejects expired codes', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			// Force expiry
			const store = await svc.listInvites();
			store[code]!.expiresAt = new Date(Date.now() - 1000).toISOString();
			const { writeYamlFile } = await import('../../../utils/yaml.js');
			await writeYamlFile(join(tempDir, 'system', 'invites.yaml'), store);

			await expect(svc.redeemCode(code, 'user123')).rejects.toThrow('expired');
		});
	});

	// --- listInvites ---

	describe('listInvites', () => {
		it('returns empty object when no invites exist', async () => {
			const svc = makeService();
			const store = await svc.listInvites();
			expect(store).toEqual({});
		});

		it('returns all invites', async () => {
			const svc = makeService();
			const code1 = await svc.createInvite('Alice', 'admin');
			const code2 = await svc.createInvite('Bob', 'admin');

			const store = await svc.listInvites();
			expect(Object.keys(store)).toHaveLength(2);
			expect(store[code1]?.name).toBe('Alice');
			expect(store[code2]?.name).toBe('Bob');
		});

		it('reads from disk each time (no stale cache)', async () => {
			const svc1 = makeService();
			const code = await svc1.createInvite('Alice', 'admin');

			const svc2 = makeService();
			const store = await svc2.listInvites();
			expect(store[code]).toBeDefined();
		});
	});

	// --- cleanup ---

	describe('cleanup', () => {
		it('removes expired+used codes older than 7 days', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			await svc.redeemCode(code, 'user123');

			// Manually set usedAt to 8 days ago and expiresAt to 8 days ago
			const store = await svc.listInvites();
			const invite = store[code];
			if (invite) {
				invite.expiresAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
				invite.usedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
			}
			const { writeYamlFile } = await import('../../../utils/yaml.js');
			const { join: pathJoin } = await import('node:path');
			await writeYamlFile(pathJoin(tempDir, 'system', 'invites.yaml'), store);

			await svc.cleanup();

			const afterStore = await svc.listInvites();
			expect(afterStore[code]).toBeUndefined();
		});

		it('keeps used codes that are less than 7 days old', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			await svc.redeemCode(code, 'user123');

			// usedAt is now (fresh), should not be cleaned up
			await svc.cleanup();

			const store = await svc.listInvites();
			expect(store[code]).toBeDefined();
		});

		it('keeps expired-but-unused codes (not yet 7 days old)', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			// Expire the code (no usedBy), but it's still recent
			const store = await svc.listInvites();
			const invite = store[code];
			if (invite) {
				invite.expiresAt = new Date(Date.now() - 1000).toISOString();
			}
			const { writeYamlFile } = await import('../../../utils/yaml.js');
			const { join: pathJoin } = await import('node:path');
			await writeYamlFile(pathJoin(tempDir, 'system', 'invites.yaml'), store);

			await svc.cleanup();

			const afterStore = await svc.listInvites();
			expect(afterStore[code]).toBeDefined();
		});

		it('does not fail when no invites file exists', async () => {
			const svc = makeService();
			await expect(svc.cleanup()).resolves.not.toThrow();
		});

		it('removes only old expired+used codes, keeps active ones', async () => {
			const svc = makeService();
			const oldCode = await svc.createInvite('Old User', 'admin');
			const activeCode = await svc.createInvite('Active User', 'admin');

			// Mark oldCode as used and expired 8 days ago
			const store = await svc.listInvites();
			const oldInvite = store[oldCode];
			if (oldInvite) {
				oldInvite.expiresAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
				oldInvite.usedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
				oldInvite.usedBy = 'someuser';
			}
			const { writeYamlFile } = await import('../../../utils/yaml.js');
			const { join: pathJoin } = await import('node:path');
			await writeYamlFile(pathJoin(tempDir, 'system', 'invites.yaml'), store);

			await svc.cleanup();

			const afterStore = await svc.listInvites();
			expect(afterStore[oldCode]).toBeUndefined();
			expect(afterStore[activeCode]).toBeDefined();
		});
	});

	// --- security ---

	describe('security', () => {
		it('generates unique codes (no collisions in batch)', async () => {
			const svc = makeService();
			const codes = new Set<string>();
			for (let i = 0; i < 20; i++) {
				const code = await svc.createInvite(`User${i}`, 'admin');
				codes.add(code);
			}
			expect(codes.size).toBe(20);
		});

		it('rejects code with uppercase characters (case-sensitive)', async () => {
			const svc = makeService();
			const result = await svc.validateCode('ABCD1234');
			expect(result).toEqual({ error: 'Invalid invite code.' });
		});

		it('rejects code with special characters', async () => {
			const svc = makeService();
			const result = await svc.validateCode('abc<>!@#');
			expect(result).toEqual({ error: 'Invalid invite code.' });
		});

		it('handles concurrent redemption safely (second call sees used code)', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			await svc.redeemCode(code, '222');
			const result = await svc.validateCode(code);
			expect(result).toEqual({ error: 'This invite code has already been used.' });
		});
	});

	// --- claimAndRedeem ---

	describe('claimAndRedeem', () => {
		it('atomically validates and redeems a code', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			const result = await svc.claimAndRedeem(code, '111');
			expect('invite' in result).toBe(true);

			const store = await svc.listInvites();
			expect(store[code].usedBy).toBe('111');
			expect(store[code].usedAt).not.toBeNull();
		});

		it('rejects invalid codes', async () => {
			const svc = makeService();
			const result = await svc.claimAndRedeem('nonexistent', '111');
			expect(result).toEqual({ error: 'Invalid invite code.' });
		});

		it('rejects expired codes', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			// Force expiry by modifying the store directly
			const store = await svc.listInvites();
			store[code].expiresAt = new Date(Date.now() - 1000).toISOString();
			const { writeYamlFile } = await import('../../../utils/yaml.js');
			await writeYamlFile(join(tempDir, 'system', 'invites.yaml'), store);

			const result = await svc.claimAndRedeem(code, '111');
			expect(result).toEqual({
				error: 'This invite code has expired. Ask the admin for a new one.',
			});
		});

		it('rejects already-used codes', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');
			await svc.claimAndRedeem(code, '111');

			const result = await svc.claimAndRedeem(code, '222');
			expect(result).toEqual({ error: 'This invite code has already been used.' });
		});

		it('same user retrying after registration failure gets success (idempotent)', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			// First claim succeeds
			const first = await svc.claimAndRedeem(code, '111');
			expect(first).toHaveProperty('invite');

			// Same user retrying — should succeed, not error
			const retry = await svc.claimAndRedeem(code, '111');
			expect(retry).toHaveProperty('invite');

			// Different user still rejected
			const other = await svc.claimAndRedeem(code, '222');
			expect(other).toEqual({ error: 'This invite code has already been used.' });
		});

		it('allows exactly one winner in concurrent redemptions', async () => {
			const svc = makeService();
			const code = await svc.createInvite('Alice', 'admin');

			const results = await Promise.all([
				svc.claimAndRedeem(code, '111'),
				svc.claimAndRedeem(code, '222'),
			]);

			const successes = results.filter((r) => 'invite' in r);
			const failures = results.filter((r) => 'error' in r);

			expect(successes).toHaveLength(1);
			expect(failures).toHaveLength(1);

			// The winner's ID is persisted
			const store = await svc.listInvites();
			expect(store[code].usedBy).not.toBeNull();
		});
	});
});
