/**
 * Invite name validation tests.
 *
 * Covers the *ambiguity-against-id-space* guards added to createInvite:
 *  - Names must not be blank (after trim).
 *  - Names must not be purely digits (would shadow a numeric Telegram id).
 *  - Names must not equal an existing user's numeric Telegram id.
 *  - Names are stored trimmed.
 *
 * Real uniqueness vs. other `user.name` lives in `invite-name-uniqueness.test.ts`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InviteService } from '../index.js';

const logger = pino({ level: 'silent' });

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-invite-name-validation-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeService(opts?: { knownUserIds?: Iterable<string> }): InviteService {
	const ids = opts?.knownUserIds ?? [];
	return new InviteService({
		dataDir: tempDir,
		logger,
		knownUserIds: () => ids,
	});
}

describe('createInvite name validation', () => {
	it('rejects names that are purely digits', async () => {
		const svc = makeService();
		await expect(svc.createInvite('12345', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/numeric-only/i,
		);
	});

	it("rejects names equal to an existing user's Telegram id", async () => {
		const svc = makeService({ knownUserIds: new Set(['8187111554']) });
		await expect(
			svc.createInvite('8187111554', 'admin1', { householdId: 'h1' }),
		).rejects.toThrow(/matches an existing user id/i);
	});

	it('accepts ordinary names', async () => {
		const svc = makeService();
		await expect(svc.createInvite('Sarah', 'admin1', { householdId: 'h1' })).resolves.toMatch(
			/^[0-9a-f]{8}$/,
		);
	});

	// --- Padding / blank edge cases (Codex M1 correction) ---

	it('rejects whitespace-padded numeric strings (e.g. " 12345 ")', async () => {
		const svc = makeService();
		await expect(svc.createInvite(' 12345 ', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/numeric-only/i,
		);
	});

	it('rejects empty string as blank', async () => {
		const svc = makeService();
		await expect(svc.createInvite('', 'admin1', { householdId: 'h1' })).rejects.toThrow(/blank/i);
	});

	it('rejects whitespace-only string as blank', async () => {
		const svc = makeService();
		await expect(svc.createInvite('   ', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/blank/i,
		);
	});

	it('accepts a padded ordinary name and stores it trimmed', async () => {
		const svc = makeService();
		const code = await svc.createInvite(' Sarah ', 'admin1', { householdId: 'h1' });

		const store = await svc.listInvites();
		expect(store[code]?.name).toBe('Sarah');
	});

	it("rejects names equal to an existing user's Telegram id even with padding", async () => {
		const svc = makeService({ knownUserIds: new Set(['8187111554']) });
		await expect(
			svc.createInvite(' 8187111554 ', 'admin1', { householdId: 'h1' }),
		).rejects.toThrow(/numeric-only|matches an existing user id/i);
	});

	it('works when knownUserIds option is omitted (no id check, but other guards still apply)', async () => {
		const svc = new InviteService({ dataDir: tempDir, logger });
		// Numeric-only still rejected
		await expect(svc.createInvite('12345', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/numeric-only/i,
		);
		// Blank still rejected
		await expect(svc.createInvite('', 'admin1', { householdId: 'h1' })).rejects.toThrow(/blank/i);
		// Ordinary name still works
		await expect(svc.createInvite('Sarah', 'admin1', { householdId: 'h1' })).resolves.toMatch(
			/^[0-9a-f]{8}$/,
		);
	});
});
