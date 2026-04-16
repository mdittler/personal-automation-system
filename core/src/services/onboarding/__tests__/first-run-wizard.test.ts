/**
 * D5b-9a: First-run wizard tests.
 *
 * Tests the state machine, TTL, digest preference storage, and coverage
 * gaps identified in end-of-phase review.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirstRunWizardDeps } from '../first-run-wizard.js';
import {
	__resetFirstRunWizardForTests,
	beginFirstRunWizard,
	handleFirstRunWizardCallback,
	handleFirstRunWizardReply,
	hasPendingFirstRunWizard,
} from '../first-run-wizard.js';
import { parse } from 'yaml';

function makeDeps(overrides?: Partial<FirstRunWizardDeps>): FirstRunWizardDeps {
	return {
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue(undefined),
		} as unknown as FirstRunWizardDeps['telegram'],
		dataDir: overrides?.dataDir ?? '/tmp/noop',
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as FirstRunWizardDeps['logger'],
		...overrides,
	};
}

let tempDir: string;

beforeEach(async () => {
	__resetFirstRunWizardForTests();
	tempDir = await mkdtemp(join(tmpdir(), 'pas-wizard-test-'));
});

afterEach(async () => {
	vi.useRealTimers(); // always restore — test 5 may have left fake timers
	__resetFirstRunWizardForTests();
	await rm(tempDir, { recursive: true, force: true });
});

describe('D5b-9a: First-run wizard', () => {
	// ---- Test 1: fresh invite redemption triggers wizard ----
	it('beginFirstRunWizard sets pending state and sends welcome + digest question', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		expect(hasPendingFirstRunWizard('user-1')).toBe(false);

		await beginFirstRunWizard(deps, 'user-1', 'Alice');

		expect(hasPendingFirstRunWizard('user-1')).toBe(true);
		expect(deps.telegram.send).toHaveBeenCalledWith(
			'user-1',
			expect.stringContaining('Welcome to PAS, Alice'),
		);
		expect(deps.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user-1',
			expect.stringContaining('daily digest'),
			expect.arrayContaining([
				expect.arrayContaining([
					expect.objectContaining({ callbackData: 'onboard:digest-yes' }),
					expect.objectContaining({ callbackData: 'onboard:digest-no' }),
				]),
			]),
		);
	});

	// ---- Test 2: onboard:digest-yes callback stores preference and clears state ----
	it('onboard:digest-yes stores yes preference and completes wizard', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		await beginFirstRunWizard(deps, 'user-2', 'Bob');

		const result = await handleFirstRunWizardCallback(deps, 'user-2', 'onboard:digest-yes');

		expect(result).toBe(true);
		expect(hasPendingFirstRunWizard('user-2')).toBe(false);

		// Verify preference persisted to disk
		const filePath = join(tempDir, 'system', 'onboarding.yaml');
		const raw = await readFile(filePath, 'utf-8');
		const data = parse(raw) as Record<string, { digestPreference: string }>;
		expect(data['user-2']?.digestPreference).toBe('yes');

		// Completion message sent
		expect(deps.telegram.send).toHaveBeenCalledWith('user-2', expect.stringContaining("You're all set"));
	});

	// ---- Test 3: onboard:digest-no callback stores preference and clears state ----
	it('onboard:digest-no stores no preference and completes wizard', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		await beginFirstRunWizard(deps, 'user-3', 'Carol');

		const result = await handleFirstRunWizardCallback(deps, 'user-3', 'onboard:digest-no');

		expect(result).toBe(true);
		expect(hasPendingFirstRunWizard('user-3')).toBe(false);

		const filePath = join(tempDir, 'system', 'onboarding.yaml');
		const raw = await readFile(filePath, 'utf-8');
		const data = parse(raw) as Record<string, { digestPreference: string }>;
		expect(data['user-3']?.digestPreference).toBe('no');
	});

	// ---- Test 4: free-text reply re-prompts with buttons ----
	it('free-text reply during wizard re-prompts with buttons, state unchanged', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		await beginFirstRunWizard(deps, 'user-4', 'Dave');

		vi.clearAllMocks();
		await handleFirstRunWizardReply(deps, 'user-4', 'yes please');

		// State still active — user is still in the wizard
		expect(hasPendingFirstRunWizard('user-4')).toBe(true);
		// Re-prompted with buttons
		expect(deps.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user-4',
			expect.any(String),
			expect.arrayContaining([
				expect.arrayContaining([
					expect.objectContaining({ callbackData: 'onboard:digest-yes' }),
				]),
			]),
		);
		// No YAML written — text reply does not advance or complete the wizard
		await expect(readFile(join(tempDir, 'system', 'onboarding.yaml'), 'utf-8')).rejects.toThrow();
	});

	// ---- Test 5: TTL expiry — state cleared, next message routes normally ----
	it('wizard TTL expiry clears state so hasPendingFirstRunWizard returns false', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		await beginFirstRunWizard(deps, 'user-5', 'Eve');

		// Advance time past the 10-minute TTL (fake timers cleaned up in afterEach)
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 11 * 60 * 1000);

		expect(hasPendingFirstRunWizard('user-5')).toBe(false);
	});

	// ---- Test 6: two users in wizard simultaneously do not interfere ----
	it('two simultaneous users do not interfere with each other', async () => {
		const deps = makeDeps({ dataDir: tempDir });

		await beginFirstRunWizard(deps, 'user-a', 'Alice');
		await beginFirstRunWizard(deps, 'user-b', 'Bob');

		expect(hasPendingFirstRunWizard('user-a')).toBe(true);
		expect(hasPendingFirstRunWizard('user-b')).toBe(true);

		// Complete user-a
		await handleFirstRunWizardCallback(deps, 'user-a', 'onboard:digest-yes');

		// user-b still pending; user-a gone
		expect(hasPendingFirstRunWizard('user-a')).toBe(false);
		expect(hasPendingFirstRunWizard('user-b')).toBe(true);
	});

	// ---- Test 7: __resetFirstRunWizardForTests clears all state ----
	it('__resetFirstRunWizardForTests clears all pending state', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		await beginFirstRunWizard(deps, 'user-x', 'X');
		await beginFirstRunWizard(deps, 'user-y', 'Y');

		__resetFirstRunWizardForTests();

		expect(hasPendingFirstRunWizard('user-x')).toBe(false);
		expect(hasPendingFirstRunWizard('user-y')).toBe(false);
	});

	// ---- Test 8: onboarding.yaml persistence round-trip ----
	it('onboarding.yaml is updated correctly with multiple users', async () => {
		const deps = makeDeps({ dataDir: tempDir });

		await beginFirstRunWizard(deps, 'u1', 'User1');
		await beginFirstRunWizard(deps, 'u2', 'User2');

		await handleFirstRunWizardCallback(deps, 'u1', 'onboard:digest-yes');
		await handleFirstRunWizardCallback(deps, 'u2', 'onboard:digest-no');

		const filePath = join(tempDir, 'system', 'onboarding.yaml');
		const raw = await readFile(filePath, 'utf-8');
		const data = parse(raw) as Record<string, { digestPreference: string; completedAt: string }>;

		expect(data['u1']?.digestPreference).toBe('yes');
		expect(data['u2']?.digestPreference).toBe('no');
		expect(data['u1']?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(data['u2']?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	// ---- Test 9 (gap): stale button press after TTL expires is silently consumed ----
	it('button press after TTL expiry is consumed (returns true) without side effects', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		await beginFirstRunWizard(deps, 'user-stale', 'Stale');

		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 11 * 60 * 1000);

		vi.clearAllMocks();
		const result = await handleFirstRunWizardCallback(deps, 'user-stale', 'onboard:digest-yes');

		// Callback consumed (true), no messages sent, no YAML written
		expect(result).toBe(true);
		expect(deps.telegram.send).not.toHaveBeenCalled();
		await expect(readFile(join(tempDir, 'system', 'onboarding.yaml'), 'utf-8')).rejects.toThrow();
	});

	// ---- Test 10 (gap): handleFirstRunWizardReply when wizard is expired — no send ----
	it('free-text reply after TTL expiry does nothing (no telegram send)', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		await beginFirstRunWizard(deps, 'user-exp', 'Expired');

		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 11 * 60 * 1000);

		vi.clearAllMocks();
		await handleFirstRunWizardReply(deps, 'user-exp', 'yes');

		expect(deps.telegram.send).not.toHaveBeenCalled();
		expect(deps.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	// ---- Test 11 (gap): unknown onboard: prefix is silently consumed ----
	it('unknown onboard: callback prefix is consumed (true) without side effects', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		await beginFirstRunWizard(deps, 'user-unk', 'Unknown');

		vi.clearAllMocks();
		const result = await handleFirstRunWizardCallback(deps, 'user-unk', 'onboard:something-else');

		expect(result).toBe(true);
		// Wizard state still active (unrecognised callback doesn't advance or clear it)
		expect(hasPendingFirstRunWizard('user-unk')).toBe(true);
		expect(deps.telegram.send).not.toHaveBeenCalled();
	});

	// ---- Test 12 (gap): beginFirstRunWizard when Telegram send fails — state still set ----
	it('beginFirstRunWizard state persists even if Telegram send fails', async () => {
		const deps = makeDeps({ dataDir: tempDir });
		(deps.telegram.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network error'));

		await beginFirstRunWizard(deps, 'user-fail', 'FailUser');

		// State was set before the send attempt — wizard is recoverable
		expect(hasPendingFirstRunWizard('user-fail')).toBe(true);
		// Error was logged
		expect(deps.logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'user-fail' }),
			expect.stringContaining('failed to send welcome'),
		);
	});
});
