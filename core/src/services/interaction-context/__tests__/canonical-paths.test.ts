/**
 * Q2(c): InteractionContextService.record() canonicalizes filePaths into the
 * household layout FileIndex uses (`households/<hh>/...`), so DataQuery's
 * exact-match `recentFilePaths` hints line up with index entries.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestContext } from '../../context/request-context.js';
import { InteractionContextServiceImpl, toCanonicalInteractionPath } from '../index.js';

describe('toCanonicalInteractionPath', () => {
	it.each([
		['users/shared/food/recipes/a.yaml', 'households/hh1/shared/food/recipes/a.yaml'],
		['users/u1/notes/daily/x.md', 'households/hh1/users/u1/notes/daily/x.md'],
		['spaces/fam/food/receipts/r.yaml', 'households/hh1/spaces/fam/food/receipts/r.yaml'],
		['users\\shared\\food\\grocery\\active.yaml', 'households/hh1/shared/food/grocery/active.yaml'],
		// already canonical for this household: unchanged
		['households/hh1/shared/food/recipes/a.yaml', 'households/hh1/shared/food/recipes/a.yaml'],
		// collaborations are cross-household and membership-checked downstream: unchanged
		['collaborations/c1/food/x.md', 'collaborations/c1/food/x.md'],
	])('%s -> %s', (input, expected) => {
		expect(toCanonicalInteractionPath(input, 'hh1')).toBe(expected);
	});

	it('drops a path that names a different household (boundary)', () => {
		expect(
			toCanonicalInteractionPath('households/hhA/shared/food/recipes/a.yaml', 'hhB'),
		).toBeNull();
	});

	it('drops traversal, absolute and null-byte paths', () => {
		expect(toCanonicalInteractionPath('users/shared/../../x.md', 'hh1')).toBeNull();
		expect(toCanonicalInteractionPath('/etc/passwd', 'hh1')).toBeNull();
		expect(toCanonicalInteractionPath('users/shared/food/a\0.md', 'hh1')).toBeNull();
	});

	it('passes everything through unchanged when there is no household context', () => {
		expect(toCanonicalInteractionPath('users/shared/food/recipes/a.yaml', undefined)).toBe(
			'users/shared/food/recipes/a.yaml',
		);
	});
});

describe('InteractionContextServiceImpl.record — canonicalization', () => {
	it('rewrites scoped paths using the request-context household', () => {
		const svc = new InteractionContextServiceImpl();
		requestContext.run({ userId: 'u1', householdId: 'hh1' }, () => {
			svc.record('u1', {
				appId: 'food',
				action: 'recipe_saved',
				filePaths: ['users/shared/food/recipes/a.yaml', 'spaces/fam/food/recipes/b.yaml'],
			});
			expect(svc.getRecent('u1')[0]?.filePaths).toEqual([
				'households/hh1/shared/food/recipes/a.yaml',
				'households/hh1/spaces/fam/food/recipes/b.yaml',
			]);
		});
	});

	it('discards foreign-household paths but keeps the rest of the entry', () => {
		const svc = new InteractionContextServiceImpl();
		requestContext.run({ userId: 'u1', householdId: 'hhB' }, () => {
			svc.record('u1', {
				appId: 'food',
				action: 'recipe_saved',
				filePaths: [
					'households/hhA/shared/food/recipes/a.yaml',
					'households/hhB/shared/food/recipes/b.yaml',
				],
			});
			expect(svc.getRecent('u1')[0]?.filePaths).toEqual([
				'households/hhB/shared/food/recipes/b.yaml',
			]);
		});
	});

	it('leaves paths untouched outside a household request context', () => {
		const svc = new InteractionContextServiceImpl();
		svc.record('u1', {
			appId: 'notes',
			action: 'view-note',
			filePaths: ['users/u1/notes/x.md'],
		});
		expect(svc.getRecent('u1')[0]?.filePaths).toEqual(['users/u1/notes/x.md']);
	});

	it('keeps an entry with no filePaths unchanged', () => {
		const svc = new InteractionContextServiceImpl();
		requestContext.run({ userId: 'u1', householdId: 'hh1' }, () => {
			svc.record('u1', { appId: 'food', action: 'x' });
			expect(svc.getRecent('u1')[0]?.filePaths).toBeUndefined();
		});
	});
});

describe('persisted legacy-form entries (written before Q2c)', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'pas-ic-legacy-'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('load unchanged (harmless: never match a FileIndex path) and age out via the 10-minute TTL', async () => {
		let now = 1_000_000_000_000;
		await mkdir(join(dir, 'system'), { recursive: true });
		await writeFile(
			join(dir, 'system', 'interaction-context.json'),
			JSON.stringify({
				version: 1,
				users: {
					u1: [
						{
							appId: 'food',
							action: 'recipe_saved',
							filePaths: ['users/shared/food/recipes/old.yaml'],
							timestamp: now - 60_000,
						},
					],
				},
			}),
		);
		const svc = new InteractionContextServiceImpl({ dataDir: dir, clock: () => now });
		await svc.loadFromDisk();
		expect(svc.getRecent('u1')[0]?.filePaths).toEqual(['users/shared/food/recipes/old.yaml']);
		now += 10 * 60 * 1000;
		expect(svc.getRecent('u1')).toEqual([]);
	});
});
