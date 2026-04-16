import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../hash.js';
import type { StoredCredential } from '../types.js';

describe('hashPassword + verifyPassword', () => {
	it('hash round-trip: hashPassword then verifyPassword returns true', async () => {
		const plaintext = 'correct-horse-battery-staple';
		const hashed = await hashPassword(plaintext);
		const stored: StoredCredential = {
			...hashed,
			sessionVersion: 1,
			updatedAt: new Date().toISOString(),
		};
		expect(await verifyPassword(plaintext, stored)).toBe(true);
	});

	it('wrong password returns false', async () => {
		const hashed = await hashPassword('the-real-password');
		const stored: StoredCredential = {
			...hashed,
			sessionVersion: 1,
			updatedAt: new Date().toISOString(),
		};
		expect(await verifyPassword('wrong-password', stored)).toBe(false);
	});

	it('unknown version field returns false without throwing', async () => {
		const hashed = await hashPassword('pw');
		const stored = {
			...hashed,
			version: 99 as unknown as 1, // unsupported version
			sessionVersion: 1,
			updatedAt: new Date().toISOString(),
		};
		expect(await verifyPassword('pw', stored)).toBe(false);
	});

	it('produces distinct salts on each call (no salt reuse)', async () => {
		const [a, b] = await Promise.all([hashPassword('pw'), hashPassword('pw')]);
		expect(a.salt).not.toBe(b.salt);
		expect(a.hash).not.toBe(b.hash);
	});
});
