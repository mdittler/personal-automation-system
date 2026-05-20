/**
 * Tests for SystemConfigWriter — read/write/reset system-scope settings.
 *
 * REQ-SETTINGS-022: atomic YAML persistence.
 * REQ-SETTINGS-023: in-memory mutation after write.
 * REQ-SETTINGS-024: concurrent writes both persist.
 * REQ-SETTINGS-036: resetToSchemaDefault removes key and mirrors default.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { SystemConfig } from '../../../types/config.js';
import { syncUsersToConfig } from '../config-writer.js';
import {
	IDLE_MINUTES_MAX,
	IDLE_MINUTES_MIN,
	RETENTION_DAYS_MAX,
	RETENTION_DAYS_MIN,
	SYSTEM_KEY_RUNTIME_PATH,
	SYSTEM_SETTING_DEFS,
} from '../settings-metadata.js';
import { SystemConfigWriter } from '../system-config-writer.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-syscfg-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makePath(filename = 'pas.yaml'): string {
	return join(tempDir, filename);
}

/** Minimal SystemConfig with all system fields at their schema defaults. */
function makeConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: tempDir,
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'tok' },
		claude: { apiKey: '', model: 'claude-sonnet-4-20250514' },
		llm: {
			providers: {},
			tiers: {
				fast: { provider: 'claude', model: 'm' },
				standard: { provider: 'claude', model: 'm' },
			},
		},
		gui: { authToken: 'tok' },
		api: { token: '' },
		n8n: { dispatchUrl: '' },
		routing: { verification: { enabled: true, upperBound: 0.7 } },
		users: [],
		webhooks: [],
		backup: { enabled: false, path: '/tmp/backups', schedule: '0 3 * * *', retentionCount: 7 },
		chat: {
			logToNotes: false,
			memory: { strict_durable_kinds: false },
			sessions: { auto_prune: false, retention_days: 90, auto_reset_idle_minutes: null },
			recall: { max_window_days: 365 },
		},
	} as unknown as SystemConfig;
}

function makeKeyDefaults(): Record<string, unknown> {
	return Object.fromEntries(SYSTEM_SETTING_DEFS.map((d) => [d.key, d.default]));
}

function makeWriter(configPath: string): SystemConfigWriter {
	return new SystemConfigWriter({
		configPath,
		runtimePathTable: SYSTEM_KEY_RUNTIME_PATH,
		keyDefaults: makeKeyDefaults(),
	});
}

async function writeSeedConfig(configPath: string, extra?: Record<string, unknown>): Promise<void> {
	const base: Record<string, unknown> = { users: [], defaults: { log_level: 'info' }, ...extra };
	await writeFile(configPath, JSON.stringify(base), 'utf-8');
}

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------

describe('SystemConfigWriter.read()', () => {
	it('reads a value from in-memory config via dot-path', () => {
		const config = makeConfig();
		const writer = makeWriter(makePath());
		expect(writer.read('chat.sessions.retention_days', config)).toBe(90);
	});

	it('reads routing.verification.upperBound via YAML key upper_bound', () => {
		const config = makeConfig();
		const writer = makeWriter(makePath());
		expect(writer.read('routing.verification.upper_bound', config)).toBe(0.7);
	});

	it('throws for a key not in the allowlist', () => {
		const config = makeConfig();
		const writer = makeWriter(makePath());
		expect(() => writer.read('unknown.key', config)).toThrow('not in the runtime path table');
	});

	it('rejects path-traversal-like inputs', () => {
		const config = makeConfig();
		const writer = makeWriter(makePath());
		expect(() => writer.read('chat.sessions.../../etc/passwd', config)).toThrow(
			'not in the runtime path table',
		);
	});
});

// ---------------------------------------------------------------------------
// write() — happy path
// ---------------------------------------------------------------------------

describe('SystemConfigWriter.write() — happy path', () => {
	it('persists retention_days to YAML', async () => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);

		await writer.write('chat.sessions.retention_days', 180, config);

		const raw = await readFile(p, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		expect(
			((parsed.chat as Record<string, unknown>).sessions as Record<string, unknown>).retention_days,
		).toBe(180);
	});

	it('mutates in-memory config after write (REQ-SETTINGS-023)', async () => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);

		await writer.write('chat.sessions.retention_days', 180, config);
		expect(config.chat?.sessions?.retention_days).toBe(180);
	});

	it('creates missing parent paths in YAML', async () => {
		const p = makePath();
		await writeFile(p, 'defaults:\n  log_level: info\n', 'utf-8'); // no chat section
		const config = makeConfig();
		const writer = makeWriter(p);

		await writer.write('chat.sessions.retention_days', 45, config);

		const raw = await readFile(p, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		expect(
			((parsed.chat as Record<string, unknown>).sessions as Record<string, unknown>).retention_days,
		).toBe(45);
	});

	it('preserves unrelated YAML keys parse-equivalently', async () => {
		const p = makePath();
		await writeSeedConfig(p, { n8n: { dispatch_url: 'http://n8n' } });
		const config = makeConfig();
		const writer = makeWriter(p);

		await writer.write('chat.sessions.auto_prune', true, config);

		const parsed = parse(await readFile(p, 'utf-8')) as Record<string, unknown>;
		expect((parsed.n8n as Record<string, unknown>).dispatch_url).toBe('http://n8n');
	});

	it('writes null for nullable auto_reset_idle_minutes', async () => {
		const p = makePath();
		await writeSeedConfig(p, { chat: { sessions: { auto_reset_idle_minutes: 60 } } });
		const config = makeConfig();
		if (config.chat?.sessions) config.chat.sessions.auto_reset_idle_minutes = 60;
		const writer = makeWriter(p);

		await writer.write('chat.sessions.auto_reset_idle_minutes', null, config);

		expect(config.chat?.sessions?.auto_reset_idle_minutes).toBeNull();
		const parsed = parse(await readFile(p, 'utf-8')) as Record<string, unknown>;
		const sessions = (parsed.chat as Record<string, unknown>).sessions as Record<string, unknown>;
		expect(sessions.auto_reset_idle_minutes).toBeNull();
	});

	it('writes routing.verification.upperBound via upper_bound key', async () => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);

		await writer.write('routing.verification.upper_bound', 0.5, config);

		expect(config.routing?.verification?.upperBound).toBe(0.5);
		const parsed = parse(await readFile(p, 'utf-8')) as Record<string, unknown>;
		expect(
			((parsed.routing as Record<string, unknown>).verification as Record<string, unknown>)
				.upper_bound,
		).toBe(0.5);
	});
});

// ---------------------------------------------------------------------------
// write() — numeric edge cases
// ---------------------------------------------------------------------------

describe('SystemConfigWriter.write() — numeric boundary values', () => {
	it.each([
		['min', RETENTION_DAYS_MIN],
		['max', RETENTION_DAYS_MAX],
	])('writes retention_days at %s boundary: %d', async (_label, value) => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);
		await writer.write('chat.sessions.retention_days', value, config);
		expect(config.chat?.sessions?.retention_days).toBe(value);
	});

	it.each([
		['min', IDLE_MINUTES_MIN],
		['max', IDLE_MINUTES_MAX],
	])('writes auto_reset_idle_minutes at %s boundary: %d', async (_label, value) => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);
		await writer.write('chat.sessions.auto_reset_idle_minutes', value, config);
		expect(config.chat?.sessions?.auto_reset_idle_minutes).toBe(value);
	});

	it.each([0.0, 0.5, 1.0])('writes upper_bound valid value %d', async (value) => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);
		await writer.write('routing.verification.upper_bound', value, config);
		expect(config.routing?.verification?.upperBound).toBe(value);
	});
});

// ---------------------------------------------------------------------------
// write() — error handling / rollback
// ---------------------------------------------------------------------------

describe('SystemConfigWriter.write() — error handling', () => {
	it('rolls back in-memory mutation when YAML write fails (missing file)', async () => {
		const p = makePath('nonexistent.yaml'); // never created
		const config = makeConfig();
		const writer = makeWriter(p);

		await expect(writer.write('chat.sessions.retention_days', 999, config)).rejects.toThrow();
		// In-memory rolled back to original value
		expect(config.chat?.sessions?.retention_days).toBe(90);
	});

	it('throws for a key not in the allowlist', async () => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);
		await expect(writer.write('bad.key', 1, config)).rejects.toThrow(
			'not in the runtime path table',
		);
	});
});

// ---------------------------------------------------------------------------
// resetToSchemaDefault() (REQ-SETTINGS-036)
// ---------------------------------------------------------------------------

describe('SystemConfigWriter.resetToSchemaDefault()', () => {
	it('removes key from YAML and returns schema default', async () => {
		const p = makePath();
		await writeSeedConfig(p, {
			chat: { sessions: { retention_days: 180 } },
		});
		const config = makeConfig();
		if (config.chat?.sessions) config.chat.sessions.retention_days = 180;
		const writer = makeWriter(p);

		const result = await writer.resetToSchemaDefault('chat.sessions.retention_days', config);

		// Returns the schema default
		expect(result).toBe(90);
		// In-memory matches default
		expect(config.chat?.sessions?.retention_days).toBe(90);
		// YAML key removed
		const parsed = parse(await readFile(p, 'utf-8')) as Record<string, unknown>;
		const sessions = (parsed.chat as Record<string, unknown> | undefined)?.sessions as
			| Record<string, unknown>
			| undefined;
		expect(sessions?.retention_days).toBeUndefined();
	});

	it('is idempotent when value is already at default', async () => {
		const p = makePath();
		await writeSeedConfig(p); // no chat.sessions.retention_days
		const config = makeConfig();
		const writer = makeWriter(p);

		const result = await writer.resetToSchemaDefault('chat.sessions.retention_days', config);
		expect(result).toBe(90);
		expect(config.chat?.sessions?.retention_days).toBe(90);
	});

	it('resets auto_prune to false', async () => {
		const p = makePath();
		await writeSeedConfig(p, { chat: { sessions: { auto_prune: true } } });
		const config = makeConfig();
		if (config.chat?.sessions) config.chat.sessions.auto_prune = true;
		const writer = makeWriter(p);

		const result = await writer.resetToSchemaDefault('chat.sessions.auto_prune', config);
		expect(result).toBe(false);
		expect(config.chat?.sessions?.auto_prune).toBe(false);
	});

	it('resets routing.verification.upper_bound to 0.7', async () => {
		const p = makePath();
		await writeSeedConfig(p, { routing: { verification: { upper_bound: 0.3 } } });
		const config = makeConfig();
		if (config.routing?.verification) config.routing.verification.upperBound = 0.3;
		const writer = makeWriter(p);

		const result = await writer.resetToSchemaDefault('routing.verification.upper_bound', config);
		expect(result).toBe(0.7);
		expect(config.routing?.verification?.upperBound).toBe(0.7);
	});

	it('throws for a key not in the allowlist', async () => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);
		await expect(writer.resetToSchemaDefault('unknown.key', config)).rejects.toThrow(
			'not in the runtime path table',
		);
	});
});

// ---------------------------------------------------------------------------
// Concurrency (REQ-SETTINGS-024)
// ---------------------------------------------------------------------------

describe('SystemConfigWriter — concurrency', () => {
	it('two concurrent writes to different keys both persist', async () => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);

		await Promise.all([
			writer.write('chat.sessions.retention_days', 120, config),
			writer.write('chat.sessions.auto_prune', true, config),
		]);

		const parsed = parse(await readFile(p, 'utf-8')) as Record<string, unknown>;
		const sessions = (parsed.chat as Record<string, unknown>).sessions as Record<string, unknown>;
		expect(sessions.retention_days).toBe(120);
		expect(sessions.auto_prune).toBe(true);
	});

	it('concurrent system write and users-sync both persist', async () => {
		const p = makePath();
		await writeSeedConfig(p);
		const config = makeConfig();
		const writer = makeWriter(p);

		const users = [
			{
				id: '123',
				name: 'Alice',
				isAdmin: true,
				enabledApps: ['*'] as string[],
				sharedScopes: [] as string[],
			},
		];

		await Promise.all([
			writer.write('chat.sessions.retention_days', 180, config),
			syncUsersToConfig(p, users),
		]);

		const parsed = parse(await readFile(p, 'utf-8')) as Record<string, unknown>;
		expect((parsed.users as unknown[]).length).toBe(1);
		expect(
			((parsed.chat as Record<string, unknown>).sessions as Record<string, unknown>).retention_days,
		).toBe(180);
	});
});
