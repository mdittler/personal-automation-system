/**
 * prune.test.ts
 *
 * Tests for pruneExpiredSessions() — the core retention/auto-prune logic.
 *
 * Uses real temp directories (mkdtemp + rm in afterEach) and a real SQLite DB.
 * Active sessions are NEVER pruned; only ended sessions older than retentionDays.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import { ChatTranscriptIndexImpl } from '../chat-transcript-index.js';
import { pruneExpiredSessions } from '../prune.js';
import { rebuildIndex } from '../rebuild.js';
import { encodeNew, encodeAppend } from '../../conversation-session/transcript-codec.js';
import type { ChatSessionFrontmatter, SessionTurn } from '../../conversation-session/chat-session-store.js';
import type { SessionRow } from '../types.js';
import { parsePasYamlConfig } from '../../../services/config/pas-yaml-schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function makeSessionFrontmatter(
	overrides: Partial<ChatSessionFrontmatter> & { id: string; user_id: string },
): ChatSessionFrontmatter {
	return {
		source: 'telegram',
		household_id: null,
		model: null,
		title: null,
		parent_session_id: null,
		started_at: daysAgo(10),
		ended_at: null,
		token_counts: { input: 0, output: 0 },
		...overrides,
	};
}

function makeTurn(role: 'user' | 'assistant', content: string): SessionTurn {
	return { role, content, timestamp: daysAgo(5) };
}

function buildTranscript(meta: ChatSessionFrontmatter, turns: SessionTurn[]): string {
	let raw = encodeNew(meta);
	for (const turn of turns) {
		raw = encodeAppend(raw, turn);
	}
	return raw;
}

async function writeTranscriptFile(filePath: string, content: string): Promise<void> {
	const { dirname } = await import('node:path');
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, 'utf8');
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Seeds a session in both the DB index and the filesystem.
 * Returns the absolute path to the transcript file.
 */
async function seedSession(
	index: ChatTranscriptIndexImpl,
	dataDir: string,
	opts: {
		id: string;
		userId: string;
		householdId?: string | null;
		startedAt?: string;
		endedAt?: string | null;
		turns?: SessionTurn[];
	},
): Promise<string> {
	const meta = makeSessionFrontmatter({
		id: opts.id,
		user_id: opts.userId,
		household_id: opts.householdId ?? null,
		started_at: opts.startedAt ?? daysAgo(10),
		ended_at: opts.endedAt ?? null,
	});

	const turns = opts.turns ?? [
		makeTurn('user', `Hello from session ${opts.id}`),
		makeTurn('assistant', `Reply in session ${opts.id}`),
	];

	const transcript = buildTranscript(meta, turns);

	// Write to filesystem
	let filePath: string;
	if (opts.householdId) {
		filePath = join(
			dataDir,
			'households',
			opts.householdId,
			'users',
			opts.userId,
			'chatbot',
			'conversation',
			'sessions',
			`${opts.id}.md`,
		);
	} else {
		filePath = join(
			dataDir,
			'users',
			opts.userId,
			'chatbot',
			'conversation',
			'sessions',
			`${opts.id}.md`,
		);
	}
	await writeTranscriptFile(filePath, transcript);

	// Write to DB index
	const sessionRow: SessionRow = {
		id: opts.id,
		user_id: opts.userId,
		household_id: opts.householdId ?? null,
		source: 'telegram',
		started_at: meta.started_at,
		ended_at: meta.ended_at ?? null,
		model: null,
		title: null,
	};
	await index.upsertSession(sessionRow);
	for (let i = 0; i < turns.length; i++) {
		await index.appendMessage({
			session_id: opts.id,
			turn_index: i,
			role: turns[i]!.role,
			content: turns[i]!.content,
			timestamp: turns[i]!.timestamp,
		});
	}

	return filePath;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;
let dbPath: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-prune-test-'));
	dbPath = join(tempDir, 'chat-state.db');
	await mkdir(join(tempDir, 'system'), { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: Config-loader defaults
// ---------------------------------------------------------------------------

describe('config-loader defaults', () => {
	test('absent chat.sessions → schema passes, defaults applied at load time', () => {
		// Validate via Zod schema that absent sessions section gives defaults
		const raw = parsePasYamlConfig({ chat: {} });
		// schema passes through (sessions absent) — defaults applied at config load time
		expect(raw.chat?.['sessions']).toBeUndefined();
	});

	test('absent chat.sessions → loadSystemConfig materializes auto_prune=false, retention_days=90', async () => {
		// Create a temp .env file with required env vars
		const envPath = join(tempDir, '.env');
		const envContent = [
			'TELEGRAM_BOT_TOKEN=test-bot-token-123',
			'ANTHROPIC_API_KEY=test-api-key-456',
			'GUI_AUTH_TOKEN=test-gui-token-789',
		].join('\n');
		await writeFile(envPath, envContent, 'utf8');

		// Create a temp YAML file with empty chat section
		const yamlPath = join(tempDir, 'test-pas.yaml');
		await writeFile(
			yamlPath,
			`users:
  - id: "test-user"
    name: "Test User"
    is_admin: true
    enabled_apps: ["*"]
chat: {}
`,
			'utf8',
		);

		// Load the config through the full config loader
		const { loadSystemConfig } = await import('../../../services/config/index.js');
		const config = await loadSystemConfig({
			envPath,
			configPath: yamlPath,
			mode: 'transitional',
		});

		// Assert the defaults are materialized
		expect(config.chat?.sessions?.auto_prune).toBe(false);
		expect(config.chat?.sessions?.retention_days).toBe(90);
	});

	test('explicit auto_prune=true, retention_days=30 passes schema', () => {
		const raw = parsePasYamlConfig({
			chat: { sessions: { auto_prune: true, retention_days: 30 } },
		});
		expect(raw.chat?.['sessions']).toMatchObject({ auto_prune: true, retention_days: 30 });
	});

	test('retention_days=0 fails schema validation', () => {
		expect(() =>
			parsePasYamlConfig({ chat: { sessions: { retention_days: 0 } } }),
		).toThrow();
	});

	test('retention_days=-1 fails schema validation', () => {
		expect(() =>
			parsePasYamlConfig({ chat: { sessions: { retention_days: -1 } } }),
		).toThrow();
	});

	test('retention_days=3651 fails schema validation', () => {
		expect(() =>
			parsePasYamlConfig({ chat: { sessions: { retention_days: 3651 } } }),
		).toThrow();
	});

	test('retention_days=1 passes schema', () => {
		const raw = parsePasYamlConfig({ chat: { sessions: { retention_days: 1 } } });
		expect(raw.chat?.['sessions']).toMatchObject({ retention_days: 1 });
	});

	test('retention_days=3650 passes schema', () => {
		const raw = parsePasYamlConfig({ chat: { sessions: { retention_days: 3650 } } });
		expect(raw.chat?.['sessions']).toMatchObject({ retention_days: 3650 });
	});

	test('retention_days non-integer string fails schema', () => {
		// Zod will reject a string for a number field
		expect(() =>
			parsePasYamlConfig({ chat: { sessions: { retention_days: 'never' as unknown as number } } }),
		).toThrow();
	});

	test('retention_days null fails schema', () => {
		expect(() =>
			parsePasYamlConfig({ chat: { sessions: { retention_days: null as unknown as number } } }),
		).toThrow();
	});
});

// ---------------------------------------------------------------------------
// Test 2: Active session NOT pruned
// ---------------------------------------------------------------------------

describe('active session is never pruned', () => {
	test('active session with started_at 100 days ago is not pruned', async () => {
		const dataDir = join(tempDir, 'data');
		const index = new ChatTranscriptIndexImpl(dbPath);

		// Seed an active session (no ended_at) started 100 days ago
		const filePath = await seedSession(index, dataDir, {
			id: 'active-session-100d',
			userId: 'user-alice',
			startedAt: daysAgo(100),
			endedAt: null, // active — not ended
		});

		const result = await pruneExpiredSessions(index, {
			retentionDays: 90,
			dataDir,
		});

		// Active sessions are never expired by listExpiredSessions
		expect(result.pruned).toBe(0);
		expect(result.errors).toBe(0);

		// File still exists
		expect(await fileExists(filePath)).toBe(true);

		// DB row still exists
		const meta = await index.getSessionMeta('active-session-100d');
		expect(meta).toBeDefined();

		await index.close();
	});
});

// ---------------------------------------------------------------------------
// Test 3: Ended session IS pruned
// ---------------------------------------------------------------------------

describe('ended session past retention window is pruned', () => {
	test('session ended 3 days ago with retention_days=1 is pruned', async () => {
		const dataDir = join(tempDir, 'data');
		const index = new ChatTranscriptIndexImpl(dbPath);

		const endedAt = daysAgo(3);
		const filePath = await seedSession(index, dataDir, {
			id: 'ended-session-3d',
			userId: 'user-bob',
			startedAt: daysAgo(5),
			endedAt,
			turns: [makeTurn('user', 'hello world unique phrase for testing')],
		});

		const result = await pruneExpiredSessions(index, {
			retentionDays: 1,
			dataDir,
		});

		expect(result.pruned).toBe(1);
		expect(result.errors).toBe(0);

		// File is gone
		expect(await fileExists(filePath)).toBe(false);

		// DB row is gone
		const meta = await index.getSessionMeta('ended-session-3d');
		expect(meta).toBeUndefined();

		// Messages are gone (cascade) — search returns empty
		const searchResult = await index.searchSessions({
			userId: 'user-bob',
			householdId: null,
			queryTerms: ['unique', 'phrase', 'testing'],
			limitSessions: 5,
		});
		expect(searchResult.hits).toHaveLength(0);

		await index.close();
	});
});

// ---------------------------------------------------------------------------
// Test 4: Ended session NOT pruned (too recent)
// ---------------------------------------------------------------------------

describe('ended session within retention window is not pruned', () => {
	test('session ended 3 days ago with retention_days=30 is not pruned', async () => {
		const dataDir = join(tempDir, 'data');
		const index = new ChatTranscriptIndexImpl(dbPath);

		const filePath = await seedSession(index, dataDir, {
			id: 'recent-session-3d',
			userId: 'user-charlie',
			startedAt: daysAgo(5),
			endedAt: daysAgo(3), // 3 days ago — within 30-day window
		});

		const result = await pruneExpiredSessions(index, {
			retentionDays: 30,
			dataDir,
		});

		expect(result.pruned).toBe(0);
		expect(result.errors).toBe(0);

		// File still exists
		expect(await fileExists(filePath)).toBe(true);

		// DB row still exists
		const meta = await index.getSessionMeta('recent-session-3d');
		expect(meta).toBeDefined();

		await index.close();
	});
});

// ---------------------------------------------------------------------------
// Test 5: Rebuild after prune does NOT restore pruned session
// ---------------------------------------------------------------------------

describe('rebuild does not restore pruned sessions', () => {
	test('after prune + DB delete + rebuild, pruned session stays gone', async () => {
		const dataDir = join(tempDir, 'data');
		const index = new ChatTranscriptIndexImpl(dbPath);

		// Seed and prune a session
		await seedSession(index, dataDir, {
			id: 'pruned-session-rebuild',
			userId: 'user-diana',
			startedAt: daysAgo(40),
			endedAt: daysAgo(35),
			turns: [makeTurn('user', 'this session should be gone after rebuild xyzzy')],
		});

		// Prune it
		const pruneResult = await pruneExpiredSessions(index, {
			retentionDays: 1,
			dataDir,
		});
		expect(pruneResult.pruned).toBe(1);
		await index.close();

		// Delete the DB entirely
		const { unlink } = await import('node:fs/promises');
		await unlink(dbPath).catch(() => {});

		// Rebuild from files on disk — the .md file was deleted, so it won't be re-indexed
		await rebuildIndex({ dbPath, dataDir });

		// Open the rebuilt DB and search — should find nothing
		const rebuilt = new ChatTranscriptIndexImpl(dbPath);
		try {
			const searchResult = await rebuilt.searchSessions({
				userId: 'user-diana',
				householdId: null,
				queryTerms: ['xyzzy'],
				limitSessions: 5,
			});
			expect(searchResult.hits).toHaveLength(0);

			const meta = await rebuilt.getSessionMeta('pruned-session-rebuild');
			expect(meta).toBeUndefined();
		} finally {
			await rebuilt.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Test 6: Idempotent — second run is a no-op
// ---------------------------------------------------------------------------

describe('prune is idempotent', () => {
	test('second run with same cutoff returns pruned=0', async () => {
		const dataDir = join(tempDir, 'data');
		const index = new ChatTranscriptIndexImpl(dbPath);

		await seedSession(index, dataDir, {
			id: 'idempotent-session',
			userId: 'user-eve',
			startedAt: daysAgo(20),
			endedAt: daysAgo(15),
		});

		// First prune
		const result1 = await pruneExpiredSessions(index, {
			retentionDays: 1,
			dataDir,
		});
		expect(result1.pruned).toBe(1);
		expect(result1.errors).toBe(0);

		// Second prune with same options — nothing left to prune
		const result2 = await pruneExpiredSessions(index, {
			retentionDays: 1,
			dataDir,
		});
		expect(result2.pruned).toBe(0);
		expect(result2.errors).toBe(0);

		await index.close();
	});
});

// ---------------------------------------------------------------------------
// Test 7: active-sessions.yaml cleanup
// ---------------------------------------------------------------------------

describe('active-sessions.yaml is cleaned up after prune', () => {
	test('dangling entry for pruned session id is removed from active-sessions.yaml', async () => {
		const dataDir = join(tempDir, 'data');
		const index = new ChatTranscriptIndexImpl(dbPath);

		const userId = 'user-frank';
		const sessionId = 'dangling-session-frank';

		// Seed the session in DB + filesystem
		await seedSession(index, dataDir, {
			id: sessionId,
			userId,
			startedAt: daysAgo(20),
			endedAt: daysAgo(15),
		});

		// Manually write a dangling active-sessions.yaml entry for this session
		const activeSessionsDir = join(dataDir, 'users', userId, 'chatbot', 'conversation');
		await mkdir(activeSessionsDir, { recursive: true });
		const activeSessionsPath = join(activeSessionsDir, 'active-sessions.yaml');
		const fakeEntry = {
			'default': { id: sessionId, started_at: daysAgo(20), model: null },
		};
		await writeFile(activeSessionsPath, stringifyYaml(fakeEntry), 'utf8');

		// Prune
		const result = await pruneExpiredSessions(index, {
			retentionDays: 1,
			dataDir,
		});
		expect(result.pruned).toBe(1);

		// active-sessions.yaml should no longer have the entry
		const raw = readFileSync(activeSessionsPath, 'utf8');
		const parsed = parseYaml(raw) as Record<string, unknown>;
		// The entry with id=sessionId should be gone
		for (const key of Object.keys(parsed ?? {})) {
			const entry = parsed[key] as Record<string, unknown> | null;
			expect(entry?.['id']).not.toBe(sessionId);
		}

		await index.close();
	});
});

// ---------------------------------------------------------------------------
// Test 8: Invalid retention_days values in Zod schema
// ---------------------------------------------------------------------------

describe('Zod schema rejects invalid retention_days', () => {
	const invalidValues: Array<{ label: string; value: unknown }> = [
		{ label: '0', value: 0 },
		{ label: '-1', value: -1 },
		{ label: '3651', value: 3651 },
		{ label: "'never'", value: 'never' },
		{ label: 'null', value: null },
	];

	for (const { label, value } of invalidValues) {
		test(`retention_days=${label} fails schema validation`, () => {
			expect(() =>
				parsePasYamlConfig({
					chat: { sessions: { retention_days: value as unknown as number } },
				}),
			).toThrow();
		});
	}
});

// ---------------------------------------------------------------------------
// Test 9: dry-run does not delete files or DB rows
// ---------------------------------------------------------------------------

describe('dry-run mode', () => {
	test('dry-run does not delete transcript file or DB row', async () => {
		const dataDir = join(tempDir, 'data');
		const index = new ChatTranscriptIndexImpl(dbPath);

		const filePath = await seedSession(index, dataDir, {
			id: 'dryrun-session',
			userId: 'user-grace',
			startedAt: daysAgo(10),
			endedAt: daysAgo(5),
		});

		const result = await pruneExpiredSessions(index, {
			retentionDays: 1,
			dataDir,
			dryRun: true,
		});

		// Dry-run: skipped count increases, not pruned
		expect(result.pruned).toBe(0);
		expect(result.skipped).toBe(1);
		expect(result.errors).toBe(0);

		// File still exists
		expect(await fileExists(filePath)).toBe(true);

		// DB row still exists
		const meta = await index.getSessionMeta('dryrun-session');
		expect(meta).toBeDefined();

		await index.close();
	});
});
