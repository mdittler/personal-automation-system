/**
 * Household-aware FallbackHandler tests.
 *
 * Verifies that:
 * - When householdService is wired and user has a household, the daily note is
 *   written to `households/<hh>/users/<u>/daily-notes/<date>.md`
 * - When wired but user has no household, falls back to legacy path with warn
 * - Without householdService, uses legacy `users/<u>/daily-notes/<date>.md`
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm, readdir } from 'node:fs/promises';
import { FallbackHandler } from '../fallback.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';

function makeLogger() {
	const warnFn = vi.fn();
	return {
		info: vi.fn(),
		warn: warnFn,
		error: vi.fn(),
		debug: vi.fn(),
		child: () => makeLogger(),
		_warn: warnFn,
	} as unknown as import('pino').Logger & { _warn: ReturnType<typeof vi.fn> };
}

function makeTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
	} as unknown as TelegramService;
}

function makeCtx(userId: string): MessageContext {
	return {
		userId,
		chatId: 123,
		text: 'Hello world',
		timestamp: new Date('2026-04-15T10:00:00Z'),
	} as MessageContext;
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = join(tmpdir(), `fallback-test-${Date.now()}`);
	await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe('FallbackHandler — household routing', () => {
	it('wired + household: writes daily note to household layout', async () => {
		const handler = new FallbackHandler({
			dataDir: tmpDir,
			timezone: 'UTC',
			logger: makeLogger(),
			householdService: { getHouseholdForUser: (_uid) => 'hh-a' },
		});

		await handler.handleUnrecognized(makeCtx('matt'), makeTelegram());

		const expectedDir = join(tmpDir, 'households', 'hh-a', 'users', 'matt', 'daily-notes');
		const files = await readdir(expectedDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^2026-04-15\.md$/);
	});

	it('wired + no household: writes daily note to legacy path with warn log', async () => {
		const logger = makeLogger();
		const handler = new FallbackHandler({
			dataDir: tmpDir,
			timezone: 'UTC',
			logger,
			householdService: { getHouseholdForUser: (_uid) => null },
		});

		await handler.handleUnrecognized(makeCtx('unassigned'), makeTelegram());

		const legacyDir = join(tmpDir, 'users', 'unassigned', 'daily-notes');
		const files = await readdir(legacyDir);
		expect(files).toHaveLength(1);
		// Warn was logged about missing household
		expect(logger._warn).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'unassigned' }),
			expect.stringContaining('no household'),
		);
	});

	it('no householdService: writes daily note to legacy path', async () => {
		const handler = new FallbackHandler({
			dataDir: tmpDir,
			timezone: 'UTC',
			logger: makeLogger(),
		});

		await handler.handleUnrecognized(makeCtx('legacy-user'), makeTelegram());

		const legacyDir = join(tmpDir, 'users', 'legacy-user', 'daily-notes');
		const files = await readdir(legacyDir);
		expect(files).toHaveLength(1);
	});
});
