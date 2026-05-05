import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_INTERNAL_BYPASS, ContextStoreServiceImpl } from '../index.js';

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

describe('ContextEntry kind decoration', () => {
	let tempDir: string;
	let store: ContextStoreServiceImpl;
	let logger: Logger;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-ctx-kind-'));
		logger = createMockLogger();
		store = new ContextStoreServiceImpl({ dataDir: tempDir, logger });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('listForUser', () => {
		it('returns entries decorated with correct kind from sidecar', async () => {
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			await writeFile(join(userCtxDir, 'food-preferences.md'), 'Likes pasta\n');
			await writeFile(join(userCtxDir, 'home-setup.md'), 'Mac Mini\n');
			await writeFile(
				join(userCtxDir, '.kinds.yaml'),
				'food-preferences: user-preference\nhome-setup: environment-fact\n',
			);

			const results = await store.listForUser('user1', CONTEXT_INTERNAL_BYPASS);

			const foodEntry = results.find((e) => e.key === 'food-preferences');
			const homeEntry = results.find((e) => e.key === 'home-setup');
			expect(foodEntry?.kind).toBe('user-preference');
			expect(homeEntry?.kind).toBe('environment-fact');
		});

		it('defaults to untyped when entry has no sidecar entry', async () => {
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			await writeFile(join(userCtxDir, 'notes.md'), 'Some notes\n');
			// No .kinds.yaml

			const results = await store.listForUser('user1', CONTEXT_INTERNAL_BYPASS);

			expect(results).toHaveLength(1);
			expect(results[0]?.kind).toBe('untyped');
		});

		it('silently ignores sidecar entries for non-existent slugs (no crash)', async () => {
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			await writeFile(join(userCtxDir, 'real-entry.md'), 'Real content\n');
			await writeFile(
				join(userCtxDir, '.kinds.yaml'),
				'real-entry: user-preference\nghost-entry: household-policy\n',
			);

			const results = await store.listForUser('user1', CONTEXT_INTERNAL_BYPASS);

			// Should not crash; ghost-entry is silently ignored (no matching .md file)
			expect(results).toHaveLength(1);
			expect(results[0]?.key).toBe('real-entry');
			expect(results[0]?.kind).toBe('user-preference');
		});

		it('returns kind: untyped when no sidecar file exists', async () => {
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			await writeFile(join(userCtxDir, 'prefs.md'), 'Some prefs\n');

			const results = await store.listForUser('user1', CONTEXT_INTERNAL_BYPASS);

			expect(results[0]?.kind).toBe('untyped');
		});
	});

	describe('searchForUser', () => {
		it('decorates entries from user dir with correct kind', async () => {
			const systemCtxDir = join(tempDir, 'system', 'context');
			await mkdir(systemCtxDir, { recursive: true });
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });

			await writeFile(join(userCtxDir, 'food-preferences.md'), 'Likes pasta and cooking\n');
			await writeFile(join(userCtxDir, '.kinds.yaml'), 'food-preferences: user-preference\n');

			const results = await store.searchForUser('cooking', 'user1', CONTEXT_INTERNAL_BYPASS);

			const foodEntry = results.find((e) => e.key === 'food-preferences');
			expect(foodEntry?.kind).toBe('user-preference');
		});

		it('decorates entries from system dir with kind: untyped when no system sidecar', async () => {
			const systemCtxDir = join(tempDir, 'system', 'context');
			await mkdir(systemCtxDir, { recursive: true });
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });

			await writeFile(join(systemCtxDir, 'household-info.md'), 'General household cooking info\n');
			// No .kinds.yaml in system dir

			const results = await store.searchForUser('cooking', 'user1', CONTEXT_INTERNAL_BYPASS);

			const sysEntry = results.find((e) => e.key === 'household-info');
			expect(sysEntry?.kind).toBe('untyped');
		});

		it('decorates entries from both user and system dirs with correct kinds', async () => {
			const systemCtxDir = join(tempDir, 'system', 'context');
			await mkdir(systemCtxDir, { recursive: true });
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });

			await writeFile(join(userCtxDir, 'personal.md'), 'Personal cooking style\n');
			await writeFile(join(userCtxDir, '.kinds.yaml'), 'personal: communication-preference\n');

			await writeFile(join(systemCtxDir, 'shared-policy.md'), 'Household cooking policy\n');
			await writeFile(join(systemCtxDir, '.kinds.yaml'), 'shared-policy: household-policy\n');

			const results = await store.searchForUser('cooking', 'user1', CONTEXT_INTERNAL_BYPASS);

			const personalEntry = results.find((e) => e.key === 'personal');
			const policyEntry = results.find((e) => e.key === 'shared-policy');
			expect(personalEntry?.kind).toBe('communication-preference');
			expect(policyEntry?.kind).toBe('household-policy');
		});
	});
});
