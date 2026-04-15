/**
 * Tests for syncUsersToConfig — writes users array back to pas.yaml
 * while preserving all other config sections.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { RegisteredUser } from '../../../types/users.js';
import { syncUsersToConfig } from '../config-writer.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-config-writer-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

const sampleUsers: RegisteredUser[] = [
	{
		id: '111',
		name: 'Alice',
		isAdmin: true,
		enabledApps: ['*'],
		sharedScopes: ['family', 'grocery'],
	},
	{
		id: '222',
		name: 'Bob',
		isAdmin: false,
		enabledApps: ['chatbot', 'notes'],
		sharedScopes: [],
	},
];

describe('syncUsersToConfig', () => {
	it('writes users and preserves other config sections', async () => {
		const configPath = join(tempDir, 'pas.yaml');
		const original = `users:
  - id: "999"
    name: OldUser
    is_admin: false
    enabled_apps:
      - "*"
    shared_scopes: []

defaults:
  log_level: info
  timezone: America/New_York

n8n:
  dispatch_url: http://localhost:5678/webhook/pas-dispatch

webhooks:
  - id: n8n-data
    url: http://localhost:5678/webhook/pas-data
    events:
      - data:changed
`;
		await writeFile(configPath, original, 'utf-8');

		await syncUsersToConfig(configPath, sampleUsers);

		const content = await readFile(configPath, 'utf-8');
		const parsed = parse(content) as Record<string, unknown>;

		// Other sections preserved
		expect(parsed.defaults).toEqual({ log_level: 'info', timezone: 'America/New_York' });
		expect((parsed.n8n as Record<string, unknown>).dispatch_url).toBe(
			'http://localhost:5678/webhook/pas-dispatch',
		);
		expect(Array.isArray(parsed.webhooks)).toBe(true);
		expect((parsed.webhooks as unknown[]).length).toBe(1);

		// Users replaced
		const users = parsed.users as Array<Record<string, unknown>>;
		expect(users).toHaveLength(2);
	});

	it('converts camelCase RegisteredUser fields to snake_case', async () => {
		const configPath = join(tempDir, 'pas.yaml');
		await writeFile(configPath, 'users: []\n', 'utf-8');

		await syncUsersToConfig(configPath, sampleUsers);

		const content = await readFile(configPath, 'utf-8');
		const parsed = parse(content) as Record<string, unknown>;
		const users = parsed.users as Array<Record<string, unknown>>;

		expect(users[0]).toEqual({
			id: '111',
			name: 'Alice',
			is_admin: true,
			enabled_apps: ['*'],
			shared_scopes: ['family', 'grocery'],
		});
		expect(users[1]).toEqual({
			id: '222',
			name: 'Bob',
			is_admin: false,
			enabled_apps: ['chatbot', 'notes'],
			shared_scopes: [],
		});
	});

	it('creates file if it does not exist', async () => {
		const configPath = join(tempDir, 'nonexistent.yaml');

		await syncUsersToConfig(configPath, sampleUsers);

		const content = await readFile(configPath, 'utf-8');
		const parsed = parse(content) as Record<string, unknown>;
		const users = parsed.users as Array<Record<string, unknown>>;

		expect(users).toHaveLength(2);
		expect(users[0].id).toBe('111');
	});

	it('handles empty user array', async () => {
		const configPath = join(tempDir, 'pas.yaml');
		await writeFile(
			configPath,
			`users:
  - id: "999"
    name: OldUser
    is_admin: false
    enabled_apps: ["*"]
    shared_scopes: []

defaults:
  log_level: debug
`,
			'utf-8',
		);

		await syncUsersToConfig(configPath, []);

		const content = await readFile(configPath, 'utf-8');
		const parsed = parse(content) as Record<string, unknown>;

		expect(parsed.users).toEqual([]);
		// Other sections still preserved
		expect((parsed.defaults as Record<string, unknown>).log_level).toBe('debug');
	});

	it('creates file with only users section when starting from nonexistent path', async () => {
		const configPath = join(tempDir, 'new-dir', 'pas.yaml');

		await syncUsersToConfig(configPath, [sampleUsers[0]]);

		const content = await readFile(configPath, 'utf-8');
		const parsed = parse(content) as Record<string, unknown>;
		const users = parsed.users as Array<Record<string, unknown>>;

		expect(users).toHaveLength(1);
		expect(users[0].is_admin).toBe(true);
	});

	it('serializes householdId as household_id when present', async () => {
		const configPath = join(tempDir, 'pas.yaml');
		await writeFile(configPath, 'users: []\n', 'utf-8');

		const userWithHousehold: RegisteredUser = {
			id: '333',
			name: 'Charlie',
			isAdmin: false,
			enabledApps: ['food'],
			sharedScopes: [],
			householdId: 'household-abc',
		};

		await syncUsersToConfig(configPath, [userWithHousehold]);

		const content = await readFile(configPath, 'utf-8');
		const parsed = parse(content) as Record<string, unknown>;
		const users = parsed.users as Array<Record<string, unknown>>;

		expect(users[0].household_id).toBe('household-abc');
	});

	it('omits household_id from serialized YAML when householdId is undefined', async () => {
		const configPath = join(tempDir, 'pas.yaml');
		await writeFile(configPath, 'users: []\n', 'utf-8');

		const userWithoutHousehold: RegisteredUser = {
			id: '444',
			name: 'Dana',
			isAdmin: false,
			enabledApps: ['chatbot'],
			sharedScopes: [],
			// householdId intentionally absent
		};

		await syncUsersToConfig(configPath, [userWithoutHousehold]);

		const content = await readFile(configPath, 'utf-8');
		const parsed = parse(content) as Record<string, unknown>;
		const users = parsed.users as Array<Record<string, unknown>>;

		expect(users[0]).not.toHaveProperty('household_id');
	});
});
