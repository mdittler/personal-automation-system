import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { seedUsers } from '../seed-users.js';

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'seed-users-test-'));
});

describe('seedUsers', () => {
	it('every user has householdId set', async () => {
		const result = await seedUsers({ dataDir, users: 4, households: 2 });
		for (const u of result.users) {
			expect(u.householdId).toBeTruthy();
		}
		for (const u of result.config.users) {
			expect(u.householdId).toBeTruthy();
		}
	});

	it('distributes users evenly across households', async () => {
		const result = await seedUsers({ dataDir, users: 6, households: 3 });
		const counts = new Map<string, number>();
		for (const u of result.users) {
			counts.set(u.householdId, (counts.get(u.householdId) ?? 0) + 1);
		}
		for (const [, count] of counts) {
			expect(count).toBe(2);
		}
	});

	it('all three LLM tiers point to stub', async () => {
		const result = await seedUsers({ dataDir, users: 2, households: 1 });
		const tiers = result.config.llm!.tiers;
		expect(tiers.fast).toEqual({ provider: 'stub', model: 'stub-model' });
		expect(tiers.standard).toEqual({ provider: 'stub', model: 'stub-model' });
		expect(tiers.reasoning).toEqual({ provider: 'stub', model: 'stub-model' });
	});

	it('data/system/households.yaml exists and contains all actual household IDs from result', async () => {
		const result = await seedUsers({ dataDir, users: 3, households: 2 });
		const householdsPath = join(dataDir, 'data', 'system', 'households.yaml');
		await expect(access(householdsPath)).resolves.toBeUndefined();
		const content = await readFile(householdsPath, 'utf-8');
		const parsed = parseYaml(content) as Record<string, unknown>;
		// The keys in the YAML must match exactly the IDs returned by seedUsers
		for (const hhId of result.households) {
			expect(Object.keys(parsed)).toContain(hhId);
		}
		expect(Object.keys(parsed)).toHaveLength(result.households.length);
	});

	it('every user householdId is one of the actual result.households IDs', async () => {
		const result = await seedUsers({ dataDir, users: 4, households: 2 });
		const householdSet = new Set(result.households);
		for (const u of result.users) {
			expect(householdSet.has(u.householdId)).toBe(true);
		}
	});

	it('configPath file exists and contains user IDs', async () => {
		const result = await seedUsers({ dataDir, users: 3, households: 1 });
		await expect(access(result.configPath)).resolves.toBeUndefined();
		const content = await readFile(result.configPath, 'utf-8');
		for (const u of result.users) {
			expect(content).toContain(u.id);
		}
	});

	it('configPath is within dataDir', async () => {
		const result = await seedUsers({ dataDir, users: 2, households: 1 });
		expect(result.configPath).toBe(join(dataDir, 'pas.yaml'));
	});

	it('returns the correct household and user counts', async () => {
		const result = await seedUsers({ dataDir, users: 5, households: 2 });
		expect(result.households).toHaveLength(2);
		expect(result.users).toHaveLength(5);
	});

	it('uneven distribution: 5 users / 2 households — all users have defined householdId', async () => {
		const result = await seedUsers({ dataDir, users: 5, households: 2 });
		const householdSet = new Set(result.households);
		for (const u of result.users) {
			expect(u.householdId).toBeDefined();
			expect(householdSet.has(u.householdId)).toBe(true);
		}
		// Neither household should be undefined
		for (const hhId of result.households) {
			expect(hhId).toBeDefined();
		}
	});

	it('throws a meaningful error when households <= 0', async () => {
		await expect(seedUsers({ dataDir, users: 2, households: 0 })).rejects.toThrow(
			'seedUsers: households must be > 0',
		);
		await expect(seedUsers({ dataDir, users: 2, households: -1 })).rejects.toThrow(
			'seedUsers: households must be > 0',
		);
	});

	it('throws a meaningful error when users <= 0', async () => {
		await expect(seedUsers({ dataDir, users: 0, households: 1 })).rejects.toThrow(
			'seedUsers: users must be > 0',
		);
		await expect(seedUsers({ dataDir, users: -1, households: 1 })).rejects.toThrow(
			'seedUsers: users must be > 0',
		);
	});
});
