/**
 * Tests for ContextStoreServiceImpl.listDurableForUser
 *
 * Verifies:
 * - User-only key returned with user's kind
 * - System-only key returned with system's kind
 * - Same key in both dirs → user wins, user's kind reported
 * - User dir missing → returns system-only set (no throw)
 * - System dir missing → returns user-only set (no throw)
 * - Both dirs missing → returns []
 * - kinds filter narrows results
 * - opts.bypass honored (skips actor check)
 * - Household-aware routing
 * - User without household → throws HouseholdBoundaryError
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_INTERNAL_BYPASS, ContextStoreServiceImpl } from '../index.js';
import { requestContext } from '../../context/request-context.js';
import { HouseholdBoundaryError, UserBoundaryError } from '../../household/index.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

function makeHouseholdService(map: Record<string, string | null>) {
	return {
		getHouseholdForUser(userId: string): string | null {
			return userId in map ? (map[userId] ?? null) : null;
		},
	};
}

describe('ContextStoreServiceImpl.listDurableForUser', () => {
	let tempDir: string;
	let logger: Logger;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-list-durable-'));
		logger = createMockLogger();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// Helper: write a .md file + optional sidecar entry
	async function writeEntry(
		dir: string,
		slug: string,
		content: string,
		kind?: string,
	): Promise<void> {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${slug}.md`), content);
		if (kind) {
			// Merge into or create a .kinds.yaml
			const kindPath = join(dir, '.kinds.yaml');
			let existing = '';
			try {
				existing = await (await import('node:fs/promises')).readFile(kindPath, 'utf-8');
			} catch {
				// file doesn't exist yet
			}
			await writeFile(kindPath, `${existing}${slug}: ${kind}\n`);
		}
	}

	it('user-only key → returned with user kind', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
		const userDir = join(tempDir, 'users', 'alice', 'context');
		await writeEntry(userDir, 'food-prefs', 'Loves sushi', 'user-preference');

		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('alice'),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.key).toBe('food-prefs');
		expect(results[0]?.content).toBe('Loves sushi');
		expect(results[0]?.kind).toBe('user-preference');
	});

	it('system-only key → returned with system kind', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
		const sysDir = join(tempDir, 'system', 'context');
		await writeEntry(sysDir, 'household-info', 'Mac Mini, living room', 'environment-fact');

		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('alice'),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.key).toBe('household-info');
		expect(results[0]?.kind).toBe('environment-fact');
	});

	it('same key in both dirs → user wins; user kind reported, NOT system kind', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
		const userDir = join(tempDir, 'users', 'alice', 'context');
		const sysDir = join(tempDir, 'system', 'context');

		await writeEntry(sysDir, 'prefs', 'System default prefs', 'household-policy');
		await writeEntry(userDir, 'prefs', 'Alice personal prefs', 'user-preference');

		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('alice'),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.content).toBe('Alice personal prefs');
		expect(results[0]?.kind).toBe('user-preference');
	});

	it('user dir missing → returns system-only set, no throw', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
		const sysDir = join(tempDir, 'system', 'context');
		await writeEntry(sysDir, 'timezone', 'America/New_York', 'environment-fact');
		// user dir deliberately not created

		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('alice'),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.key).toBe('timezone');
		expect(results[0]?.kind).toBe('environment-fact');
	});

	it('system dir missing → returns user-only set, no throw', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
		const userDir = join(tempDir, 'users', 'alice', 'context');
		await writeEntry(userDir, 'diet', 'Vegetarian', 'user-preference');
		// system dir deliberately not created

		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('alice'),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.key).toBe('diet');
	});

	it('both dirs missing → returns []', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });

		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('alice'),
		);
		expect(results).toEqual([]);
	});

	it('kinds filter [user-preference] → only user-preference entries returned', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
		const userDir = join(tempDir, 'users', 'alice', 'context');
		const sysDir = join(tempDir, 'system', 'context');

		await writeEntry(userDir, 'diet', 'Vegan', 'user-preference');
		await writeEntry(sysDir, 'household-policy', 'No shoes inside', 'household-policy');
		await writeEntry(sysDir, 'env-fact', 'Latitude 40N', 'environment-fact');

		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('alice', { kinds: ['user-preference'] }),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.key).toBe('diet');
		expect(results[0]?.kind).toBe('user-preference');
	});

	it('opts.bypass honored — skips actor check (actor !== target)', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
		const userDir = join(tempDir, 'users', 'bob', 'context');
		await writeEntry(userDir, 'note', 'Bob content', 'user-preference');

		// actor is 'alice', target is 'bob' — should fail without bypass
		await expect(
			requestContext.run({ userId: 'alice' }, () => store.listDurableForUser('bob')),
		).rejects.toThrow(UserBoundaryError);

		// with bypass, should succeed
		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('bob', { bypass: CONTEXT_INTERNAL_BYPASS }),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.key).toBe('note');
	});

	it('household-aware: with householdService + user has household → reads from household path', async () => {
		const store = new ContextStoreServiceImpl({
			dataDir: tempDir,
			logger,
			householdService: makeHouseholdService({ matt: 'hh-a' }),
		});

		const hhUserDir = join(tempDir, 'households', 'hh-a', 'users', 'matt', 'context');
		await writeEntry(hhUserDir, 'cooking-style', 'Italian', 'user-preference');

		const results = await requestContext.run({ userId: 'matt' }, () =>
			store.listDurableForUser('matt'),
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.key).toBe('cooking-style');
		expect(results[0]?.kind).toBe('user-preference');
	});

	it('household-aware: user without household → throws HouseholdBoundaryError', async () => {
		const store = new ContextStoreServiceImpl({
			dataDir: tempDir,
			logger,
			householdService: makeHouseholdService({ unassigned: null }),
		});

		await expect(
			requestContext.run({ userId: 'unassigned' }, () =>
				store.listDurableForUser('unassigned'),
			),
		).rejects.toThrow(HouseholdBoundaryError);
	});

	it('default: untyped entries ARE included (CONTEXT_ENTRY_KINDS is the default)', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
		const userDir = join(tempDir, 'users', 'alice', 'context');
		// untyped entry — no sidecar kind set
		await writeEntry(userDir, 'random-note', 'Some random note');

		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('alice'),
		);
		// untyped IS in CONTEXT_ENTRY_KINDS, so it should be included by default
		expect(results).toHaveLength(1);
		expect(results[0]?.key).toBe('random-note');
		expect(results[0]?.kind).toBe('untyped');
	});

	it('default includes all CONTEXT_ENTRY_KINDS (6 kinds, including untyped) when no filter supplied', async () => {
		const store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
		const userDir = join(tempDir, 'users', 'alice', 'context');

		await writeEntry(userDir, 'pref', 'My preference', 'user-preference');
		await writeEntry(userDir, 'comm', 'Comms style', 'communication-preference');
		await writeEntry(userDir, 'env', 'Environment note', 'environment-fact');
		await writeEntry(userDir, 'conv', 'Convention', 'project-convention');
		await writeEntry(userDir, 'policy', 'Household rule', 'household-policy');
		await writeEntry(userDir, 'untyped-note', 'Raw note'); // untyped — included by default

		const results = await requestContext.run({ userId: 'alice' }, () =>
			store.listDurableForUser('alice'),
		);
		expect(results).toHaveLength(6);
		const kinds = results.map((e) => e.kind);
		expect(kinds).toContain('user-preference');
		expect(kinds).toContain('communication-preference');
		expect(kinds).toContain('environment-fact');
		expect(kinds).toContain('project-convention');
		expect(kinds).toContain('household-policy');
		expect(kinds).toContain('untyped');
	});
});
