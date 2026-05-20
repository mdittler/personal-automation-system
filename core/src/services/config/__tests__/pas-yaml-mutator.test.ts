/**
 * Tests for mutatePasYaml — atomic RMW under shared file lock.
 *
 * REQ-SETTINGS-022: atomic persistence preserving unmodified keys.
 * REQ-SETTINGS-024: concurrent writes serialise; both persist.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { syncUsersToConfig } from '../config-writer.js';
import { mutatePasYaml } from '../pas-yaml-mutator.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-mutator-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function configPath(filename = 'pas.yaml'): string {
	return join(tempDir, filename);
}

async function writeConfig(content: string, filename = 'pas.yaml'): Promise<string> {
	const p = configPath(filename);
	await writeFile(p, content, 'utf-8');
	return p;
}

async function readParsed(filename = 'pas.yaml'): Promise<Record<string, unknown>> {
	const content = await readFile(configPath(filename), 'utf-8');
	return (parse(content) as Record<string, unknown>) ?? {};
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('mutatePasYaml', () => {
	it('applies mutator and writes back', async () => {
		const p = await writeConfig('foo: bar\nbaz: 42\n');
		await mutatePasYaml(p, (parsed) => {
			parsed['baz'] = 99;
			return parsed;
		});
		const result = await readParsed();
		expect(result['baz']).toBe(99);
	});

	it('preserves unrelated top-level keys parse-equivalently (not byte-equal)', async () => {
		const original = `users:
  - id: "123"
    name: Alice
    is_admin: true
    enabled_apps:
      - "*"
    shared_scopes: []
defaults:
  log_level: info
  timezone: UTC
n8n:
  dispatch_url: http://localhost:5678/webhook/pas
`;
		const p = await writeConfig(original);

		await mutatePasYaml(p, (parsed) => {
			// Only touch a system key
			const chat = (parsed['chat'] as Record<string, unknown> | undefined) ?? {};
			const sessions = (chat['sessions'] as Record<string, unknown> | undefined) ?? {};
			sessions['retention_days'] = 180;
			chat['sessions'] = sessions;
			parsed['chat'] = chat;
			return parsed;
		});

		const resultParsed = await readParsed();
		const originalParsed = parse(original) as Record<string, unknown>;

		// Unrelated keys parse-equivalent
		expect(resultParsed['defaults']).toEqual(originalParsed['defaults']);
		expect(resultParsed['n8n']).toEqual(originalParsed['n8n']);
		// users array parse-equivalent
		expect(resultParsed['users']).toEqual(originalParsed['users']);
		// New key present
		expect(
			((resultParsed['chat'] as Record<string, unknown>)['sessions'] as Record<string, unknown>)[
				'retention_days'
			],
		).toBe(180);
	});

	it('creates nested paths when intermediate keys are absent', async () => {
		const p = await writeConfig('defaults:\n  log_level: info\n');
		await mutatePasYaml(p, (parsed) => {
			parsed['chat'] = { sessions: { retention_days: 90 } };
			return parsed;
		});
		const result = await readParsed();
		expect(
			((result['chat'] as Record<string, unknown>)['sessions'] as Record<string, unknown>)[
				'retention_days'
			],
		).toBe(90);
	});

	// ---------------------------------------------------------------------------
	// Error handling
	// ---------------------------------------------------------------------------

	it('throws a descriptive error when configPath does not exist', async () => {
		const missing = join(tempDir, 'nonexistent.yaml');
		await expect(mutatePasYaml(missing, (p) => p)).rejects.toThrow('not found');
	});

	it('does NOT create a new file on ENOENT (fail-fast)', async () => {
		const missing = join(tempDir, 'does-not-exist.yaml');
		try {
			await mutatePasYaml(missing, (p) => p);
		} catch {
			// Expected
		}
		await expect(readFile(missing, 'utf-8')).rejects.toThrow();
	});

	it('leaves file unchanged when mutator throws', async () => {
		const p = await writeConfig('foo: bar\n');
		await expect(
			mutatePasYaml(p, () => {
				throw new Error('mutator error');
			}),
		).rejects.toThrow('mutator error');
		const result = await readParsed();
		expect(result['foo']).toBe('bar');
	});

	// ---------------------------------------------------------------------------
	// Concurrency (REQ-SETTINGS-024)
	// ---------------------------------------------------------------------------

	it('two concurrent writes to different keys both persist', async () => {
		const p = await writeConfig('defaults:\n  log_level: info\n');

		await Promise.all([
			mutatePasYaml(p, (parsed) => {
				parsed['key_a'] = 'value_a';
				return parsed;
			}),
			mutatePasYaml(p, (parsed) => {
				parsed['key_b'] = 'value_b';
				return parsed;
			}),
		]);

		const result = await readParsed();
		expect(result['key_a']).toBe('value_a');
		expect(result['key_b']).toBe('value_b');
	});

	it('mixed users-sync and system-write both persist', async () => {
		const p = await writeConfig('users: []\ndefaults:\n  log_level: info\n');

		const users = [
			{
				id: '111',
				name: 'Alice',
				isAdmin: true,
				enabledApps: ['*'] as string[],
				sharedScopes: [] as string[],
			},
		];

		await Promise.all([
			syncUsersToConfig(p, users),
			mutatePasYaml(p, (parsed) => {
				const chat = (parsed['chat'] as Record<string, unknown> | undefined) ?? {};
				chat['log_to_notes'] = true;
				parsed['chat'] = chat;
				return parsed;
			}),
		]);

		const result = await readParsed();
		expect((result['users'] as unknown[]).length).toBe(1);
		expect(((result['chat'] as Record<string, unknown>) ?? {})['log_to_notes']).toBe(true);
	});
});
