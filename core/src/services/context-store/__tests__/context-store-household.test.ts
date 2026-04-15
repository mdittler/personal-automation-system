/**
 * Household-aware ContextStore tests.
 *
 * Verifies that:
 * - When householdService is wired, user context resolves to `households/<hh>/users/<u>/context`
 * - When wired but user has no household, throws HouseholdBoundaryError
 * - Legacy layout (no householdService) is unchanged
 * - Actor-vs-target check throws UserBoundaryError on mismatch
 * - CONTEXT_INTERNAL_BYPASS skips the actor check
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import {
	ContextStoreServiceImpl,
	CONTEXT_INTERNAL_BYPASS,
} from '../index.js';
import { requestContext } from '../../context/request-context.js';
import { HouseholdBoundaryError, UserBoundaryError } from '../../household/index.js';

function makeLogger() {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		child: () => makeLogger(),
	} as unknown as import('pino').Logger;
}

function makeHouseholdService(map: Record<string, string | null>) {
	return {
		getHouseholdForUser(userId: string): string | null {
			return userId in map ? map[userId]! : null;
		},
	};
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = join(tmpdir(), `ctx-store-test-${Date.now()}`);
	await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe('ContextStoreServiceImpl — household routing', () => {
	it('wired + household: save resolves to households/<hh>/users/<u>/context', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
			householdService: makeHouseholdService({ matt: 'hh-a' }),
		});

		await requestContext.run({ userId: 'matt' }, () =>
			service.save('matt', 'food-prefs', 'Loves pasta'),
		);

		const expectedPath = join(
			tmpDir,
			'households',
			'hh-a',
			'users',
			'matt',
			'context',
			'food-prefs.md',
		);
		const content = await readFile(expectedPath, 'utf-8');
		expect(content).toBe('Loves pasta');
	});

	it('wired + household: listForUser round-trips data from household path', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
			householdService: makeHouseholdService({ matt: 'hh-a' }),
		});

		// Write directly into the household path to simulate migrated data
		const ctxDir = join(tmpDir, 'households', 'hh-a', 'users', 'matt', 'context');
		await mkdir(ctxDir, { recursive: true });
		await writeFile(join(ctxDir, 'diet.md'), 'Low-carb diet');

		const entries = await requestContext.run({ userId: 'matt' }, () =>
			service.listForUser('matt'),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.key).toBe('diet');
		expect(entries[0]!.content).toBe('Low-carb diet');
	});

	it('wired + no household: throws HouseholdBoundaryError', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
			householdService: makeHouseholdService({ unassigned: null }),
		});

		await expect(
			requestContext.run({ userId: 'unassigned' }, () =>
				service.listForUser('unassigned'),
			),
		).rejects.toThrow(HouseholdBoundaryError);
	});

	it('legacy (no householdService): resolves to users/<u>/context', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
		});

		await service.save('legacy-user', 'prefs', 'Legacy content');

		const expectedPath = join(tmpDir, 'users', 'legacy-user', 'context', 'prefs.md');
		const content = await readFile(expectedPath, 'utf-8');
		expect(content).toBe('Legacy content');
	});
});

describe('ContextStoreServiceImpl — actor-vs-target checks', () => {
	it('actor === target: allowed', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
		});
		await expect(
			requestContext.run({ userId: 'matt' }, () => service.listForUser('matt')),
		).resolves.toEqual([]);
	});

	it('actor !== target: throws UserBoundaryError', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
		});
		await expect(
			requestContext.run({ userId: 'alice' }, () => service.listForUser('bob')),
		).rejects.toThrow(UserBoundaryError);
	});

	it('no context (actorId undefined): allowed (system use case)', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
		});
		// No requestContext.run wrapper
		await expect(service.listForUser('matt')).resolves.toEqual([]);
	});

	it('CONTEXT_INTERNAL_BYPASS skips actor check', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
		});
		// actor !== target, but bypass is passed
		await expect(
			requestContext.run({ userId: 'alice' }, () =>
				service.listForUser('bob', CONTEXT_INTERNAL_BYPASS),
			),
		).resolves.toEqual([]);
	});

	it('actor check applies to save()', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
		});
		await expect(
			requestContext.run({ userId: 'alice' }, () =>
				service.save('bob', 'key', 'content'),
			),
		).rejects.toThrow(UserBoundaryError);
	});

	it('actor check applies to remove()', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
		});
		await expect(
			requestContext.run({ userId: 'alice' }, () =>
				service.remove('bob', 'key'),
			),
		).rejects.toThrow(UserBoundaryError);
	});

	it('actor check applies to getForUser()', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
		});
		await expect(
			requestContext.run({ userId: 'alice' }, () =>
				service.getForUser('key', 'bob'),
			),
		).rejects.toThrow(UserBoundaryError);
	});

	it('actor check applies to searchForUser()', async () => {
		const service = new ContextStoreServiceImpl({
			dataDir: tmpDir,
			logger: makeLogger(),
		});
		await expect(
			requestContext.run({ userId: 'alice' }, () =>
				service.searchForUser('pasta', 'bob'),
			),
		).rejects.toThrow(UserBoundaryError);
	});
});
