/**
 * D5b-9a: Tests for redeemInviteAndRegister — coverage gap fix.
 *
 * Verifies that the shared helper correctly calls beginFirstRunWizard
 * after successful registration, and handles error paths properly.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedeemAndRegisterDeps } from '../redeem-and-register.js';
import { redeemInviteAndRegister } from '../redeem-and-register.js';
import { __resetFirstRunWizardForTests, hasPendingFirstRunWizard } from '../../onboarding/first-run-wizard.js';

let tempDir: string;

function makeDeps(overrides?: Partial<RedeemAndRegisterDeps>): RedeemAndRegisterDeps {
	return {
		inviteService: {
			claimAndRedeem: vi.fn().mockResolvedValue({
				invite: {
					name: 'Alice',
					role: 'member',
					householdId: 'hh-1',
					enabledApps: ['*'],
					initialSpaces: [],
				},
			}),
		} as unknown as RedeemAndRegisterDeps['inviteService'],
		userMutationService: {
			registerUser: vi.fn().mockResolvedValue(undefined),
		} as unknown as RedeemAndRegisterDeps['userMutationService'],
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue(undefined),
		} as unknown as RedeemAndRegisterDeps['telegram'],
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as RedeemAndRegisterDeps['logger'],
		dataDir: tempDir,
		...overrides,
	};
}

beforeEach(async () => {
	__resetFirstRunWizardForTests();
	tempDir = await mkdtemp(join(tmpdir(), 'pas-redeem-test-'));
});

afterEach(async () => {
	__resetFirstRunWizardForTests();
	await rm(tempDir, { recursive: true, force: true });
});

describe('redeemInviteAndRegister + first-run wizard', () => {
	it('successful registration triggers beginFirstRunWizard (user enters wizard)', async () => {
		const deps = makeDeps({ dataDir: tempDir });

		const result = await redeemInviteAndRegister(deps, 'ABC123', 'user-1');

		expect(result).toEqual({ success: true, name: 'Alice' });
		// Wizard should now be pending for this user
		expect(hasPendingFirstRunWizard('user-1')).toBe(true);
		// Welcome message sent via wizard (sendWithButtons for digest question)
		expect(deps.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user-1',
			expect.stringContaining('daily digest'),
			expect.any(Array),
		);
	});

	it('invite error (e.g. expired code) does not trigger wizard', async () => {
		const deps = makeDeps({
			dataDir: tempDir,
			inviteService: {
				claimAndRedeem: vi.fn().mockResolvedValue({ error: 'Invite code not found.' }),
			} as unknown as RedeemAndRegisterDeps['inviteService'],
		});

		const result = await redeemInviteAndRegister(deps, 'BADCODE', 'user-2');

		expect(result).toEqual({ success: false, error: 'Invite code not found.' });
		expect(hasPendingFirstRunWizard('user-2')).toBe(false);
	});

	it('invite with empty householdId does not trigger wizard', async () => {
		const deps = makeDeps({
			dataDir: tempDir,
			inviteService: {
				claimAndRedeem: vi.fn().mockResolvedValue({
					invite: { name: 'Bob', role: 'member', householdId: '', enabledApps: ['*'], initialSpaces: [] },
				}),
			} as unknown as RedeemAndRegisterDeps['inviteService'],
		});

		const result = await redeemInviteAndRegister(deps, 'NOHH', 'user-3');

		expect(result.success).toBe(false);
		expect(hasPendingFirstRunWizard('user-3')).toBe(false);
	});

	it('registerUser failure does not trigger wizard', async () => {
		const deps = makeDeps({
			dataDir: tempDir,
			userMutationService: {
				registerUser: vi.fn().mockRejectedValue(new Error('config write failed')),
			} as unknown as RedeemAndRegisterDeps['userMutationService'],
		});

		await expect(redeemInviteAndRegister(deps, 'CODE', 'user-4')).rejects.toThrow('config write failed');
		expect(hasPendingFirstRunWizard('user-4')).toBe(false);
	});
});
