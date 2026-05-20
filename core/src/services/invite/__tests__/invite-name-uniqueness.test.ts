/**
 * Globally-unique display names — uniqueness contract.
 *
 * createInvite rejects:
 *   - Names that collide (case-insensitive, trimmed) with an existing user.name.
 *   - Names that collide with an ACTIVE invite (usedBy === null AND not expired).
 *
 * createInvite does NOT reject (name is free for reuse) when:
 *   - The colliding invite has been redeemed (usedBy !== null).
 *   - The colliding invite has expired (expiresAt <= now).
 *
 * Race-safety: createInvite holds `withMultiFileLock([DISPLAY_NAME_LOCK_KEY,
 * this.invitesPath], ...)` for the full read-check-write, so two concurrent
 * calls for the same name serialize and exactly one succeeds.
 *
 * Clock injection: tests pass `now: () => new Date(nowMs)` with a mutable
 * `nowMs` closure to advance time without depending on real wall-clock.
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
	tempDir = await mkdtemp(join(tmpdir(), 'pas-invite-name-uniqueness-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

interface MakeServiceOptions {
	users?: Array<{ id: string; name: string }>;
	now?: () => Date;
}

function makeService(opts: MakeServiceOptions = {}): InviteService {
	const users = opts.users ?? [];
	return new InviteService({
		dataDir: tempDir,
		logger,
		knownUsers: () => users,
		...(opts.now ? { now: opts.now } : {}),
	});
}

describe('createInvite name uniqueness — user.name collisions', () => {
	it('rejects a name that matches an existing user.name (case-insensitive)', async () => {
		const svc = makeService({ users: [{ id: '111', name: 'Sarah' }] });
		await expect(svc.createInvite('SARAH', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/already taken/i,
		);
	});

	it('rejects with whitespace padding still matching an existing user.name', async () => {
		const svc = makeService({ users: [{ id: '111', name: 'Sarah' }] });
		await expect(svc.createInvite(' sarah ', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/already taken/i,
		);
	});

	it('rejects when an existing user.name has surrounding whitespace too', async () => {
		// normalizeDisplayName trims, so " Bob " stored in user.name still blocks "bob".
		const svc = makeService({ users: [{ id: '111', name: ' Bob ' }] });
		await expect(svc.createInvite('Bob', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/already taken/i,
		);
	});

	it('allows a name that does not collide with any user', async () => {
		const svc = makeService({ users: [{ id: '111', name: 'Sarah' }] });
		await expect(svc.createInvite('Carol', 'admin1', { householdId: 'h1' })).resolves.toMatch(
			/^[0-9a-f]{8}$/,
		);
	});
});

describe('createInvite name uniqueness — active-invite collisions', () => {
	it('rejects a name that matches an active (unredeemed, unexpired) invite', async () => {
		const svc = makeService();
		await svc.createInvite('Sarah', 'admin1', { householdId: 'h1' });
		await expect(svc.createInvite('sarah', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/already taken/i,
		);
	});

	it('rejects case-insensitive collision with an active invite', async () => {
		const svc = makeService();
		await svc.createInvite('Carol', 'admin1', { householdId: 'h1' });
		await expect(svc.createInvite('CAROL', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/already taken/i,
		);
	});

	it('error message names the colliding active invite code', async () => {
		const svc = makeService();
		const firstCode = await svc.createInvite('Sarah', 'admin1', { householdId: 'h1' });
		await expect(svc.createInvite('Sarah', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			new RegExp(firstCode),
		);
	});
});

describe('createInvite name uniqueness — used and expired invites do not block', () => {
	it('allows reuse of a name from a redeemed (used) invite', async () => {
		const svc = makeService();
		const code = await svc.createInvite('Sarah', 'admin1', { householdId: 'h1' });
		// Mark the invite redeemed via the service API.
		await svc.redeemCode(code, '222');
		// `redeemCode` does NOT add a user to knownUsers (registration is a separate
		// step), so the name is now free again.
		await expect(svc.createInvite('Sarah', 'admin1', { householdId: 'h1' })).resolves.toMatch(
			/^[0-9a-f]{8}$/,
		);
	});

	it('allows reuse of a name from an expired invite (clock advanced past expiry)', async () => {
		let nowMs = new Date('2026-01-01T00:00:00.000Z').getTime();
		const svc = makeService({ now: () => new Date(nowMs) });

		await svc.createInvite('Sarah', 'admin1', { householdId: 'h1' });

		// Advance 25h so the original 24h-TTL invite is now expired.
		nowMs += 25 * 60 * 60 * 1000;

		await expect(svc.createInvite('Sarah', 'admin1', { householdId: 'h1' })).resolves.toMatch(
			/^[0-9a-f]{8}$/,
		);
	});

	it('treats expiresAt === now as expired (does not block)', async () => {
		// Edge case: createInvite uses `new Date(invite.expiresAt) <= nowDate`, so
		// the exact-equal case is treated as expired and the name is free.
		let nowMs = new Date('2026-01-01T00:00:00.000Z').getTime();
		const svc = makeService({ now: () => new Date(nowMs) });

		await svc.createInvite('Sarah', 'admin1', { householdId: 'h1' });

		// Advance exactly 24h — expiresAt equals nowDate.
		nowMs += 24 * 60 * 60 * 1000;

		await expect(svc.createInvite('Sarah', 'admin1', { householdId: 'h1' })).resolves.toMatch(
			/^[0-9a-f]{8}$/,
		);
	});
});

describe('createInvite name uniqueness — concurrent races', () => {
	it('two concurrent createInvite calls for the same name → exactly one succeeds', async () => {
		const svc = makeService();
		const results = await Promise.allSettled([
			svc.createInvite('Sarah', 'admin1', { householdId: 'h1' }),
			svc.createInvite('Sarah', 'admin1', { householdId: 'h1' }),
		]);

		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already taken/i);
	});

	it('concurrent calls for DIFFERENT names both succeed', async () => {
		const svc = makeService();
		const results = await Promise.allSettled([
			svc.createInvite('Sarah', 'admin1', { householdId: 'h1' }),
			svc.createInvite('Carol', 'admin1', { householdId: 'h1' }),
		]);

		expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
	});
});

describe('createInvite — knownUsers contract', () => {
	it('constructor throws when knownUsers is omitted (required contract)', () => {
		// knownUsers is a required option — createInvite relies on it for both the
		// id-collision and name-collision checks. An untyped JS caller that omits
		// it must fail fast at construction, not silently skip the checks.
		expect(
			() =>
				new InviteService({
					dataDir: tempDir,
					logger,
				} as unknown as ConstructorParameters<typeof InviteService>[0]),
		).toThrow(/knownUsers/i);
	});

	it('accepts an empty-returning knownUsers function (no users yet)', async () => {
		const svc = new InviteService({ dataDir: tempDir, logger, knownUsers: () => [] });
		// First creation succeeds; second is still rejected by the active-invite check.
		await svc.createInvite('Sarah', 'admin1', { householdId: 'h1' });
		await expect(svc.createInvite('Sarah', 'admin1', { householdId: 'h1' })).rejects.toThrow(
			/already taken/i,
		);
	});
});
