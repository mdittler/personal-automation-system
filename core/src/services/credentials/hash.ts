/**
 * Password hashing utilities using Node.js built-in crypto.scrypt.
 *
 * No external dependencies. Uses scrypt with conservative parameters
 * suitable for a household-scale tool.
 *
 * NEVER log or return the plaintext or hash values from callers.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { StoredCredential } from './types.js';

const scryptAsync = promisify(scrypt);

/** scrypt parameters. N=16384 is the OWASP minimum for interactive logins. */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64 } as const;

/**
 * Hash a plaintext password.
 * Returns a StoredCredential fragment (everything except sessionVersion/updatedAt).
 */
export async function hashPassword(
	plaintext: string,
): Promise<Pick<StoredCredential, 'version' | 'algo' | 'salt' | 'hash' | 'params'>> {
	const salt = randomBytes(16).toString('hex');
	const key = (await scryptAsync(plaintext, salt, SCRYPT_PARAMS.keyLen)) as Buffer;
	return {
		version: 1,
		algo: 'scrypt',
		salt,
		hash: key.toString('hex'),
		params: SCRYPT_PARAMS,
	};
}

/**
 * Verify a plaintext password against a stored credential.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function verifyPassword(
	plaintext: string,
	stored: StoredCredential,
): Promise<boolean> {
	if (stored.version !== 1 || stored.algo !== 'scrypt') {
		return false;
	}
	try {
		const { N, r, p, keyLen } = stored.params;
		const candidate = (await scryptAsync(plaintext, stored.salt, keyLen, { N, r, p })) as Buffer;
		const expected = Buffer.from(stored.hash, 'hex');
		// timingSafeEqual requires identical lengths; mismatch would indicate
		// corrupted stored data — treat as verification failure.
		if (candidate.length !== expected.length) return false;
		return timingSafeEqual(candidate, expected);
	} catch {
		return false;
	}
}
