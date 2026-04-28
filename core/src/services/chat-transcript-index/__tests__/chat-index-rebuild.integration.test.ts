/**
 * chat-index-rebuild.integration.test.ts
 *
 * Parity test for the chat-index-rebuild CLI:
 *  1. Seeds transcript Markdown files in both legacy and household path layouts.
 *  2. Indexes them into a fresh ChatTranscriptIndexImpl.
 *  3. Records search results for several queries.
 *  4. Deletes the DB.
 *  5. Calls rebuildIndex() (imported function, no subprocess).
 *  6. Creates a new ChatTranscriptIndexImpl pointing at the rebuilt DB.
 *  7. Asserts search results match.
 *  8. Asserts a corrupt .md file is skipped without throwing.
 */

import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
	ChatSessionFrontmatter,
	SessionTurn,
} from '../../conversation-session/chat-session-store.js';
import { encodeAppend, encodeNew } from '../../conversation-session/transcript-codec.js';
import { ChatTranscriptIndexImpl } from '../chat-transcript-index.js';
import { rebuildIndex } from '../rebuild.js';
import type { InternalSearchFilters, MessageRow, SessionRow } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionFrontmatter(
	overrides: Partial<ChatSessionFrontmatter> & { id: string; user_id: string },
): ChatSessionFrontmatter {
	return {
		source: 'telegram',
		household_id: null,
		model: null,
		title: null,
		parent_session_id: null,
		started_at: '2026-01-01T00:00:00Z',
		ended_at: null,
		token_counts: { input: 0, output: 0 },
		...overrides,
	};
}

function makeTurn(role: 'user' | 'assistant', content: string, timestamp: string): SessionTurn {
	return { role, content, timestamp };
}

/**
 * Builds a complete transcript string from a frontmatter + turns, using the
 * same codec the production system uses.
 */
function buildTranscript(meta: ChatSessionFrontmatter, turns: SessionTurn[]): string {
	let raw = encodeNew(meta);
	for (const turn of turns) {
		raw = encodeAppend(raw, turn);
	}
	return raw;
}

/**
 * Writes a transcript .md file at the given path (creating parent dirs).
 */
async function writeTranscriptFile(filePath: string, content: string): Promise<void> {
	const { dirname } = await import('node:path');
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, 'utf8');
}

function makeSessionRow(
	overrides: Partial<SessionRow> & { id: string; user_id: string },
): SessionRow {
	return {
		household_id: null,
		source: 'telegram',
		started_at: '2026-01-01T00:00:00Z',
		ended_at: null,
		model: null,
		title: null,
		...overrides,
	};
}

function makeMessageRow(
	overrides: Partial<MessageRow> & { session_id: string; turn_index: number; content: string },
): MessageRow {
	return {
		role: 'user',
		timestamp: '2026-01-01T00:00:01Z',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Test data definitions
// ---------------------------------------------------------------------------

interface TestSession {
	meta: ChatSessionFrontmatter;
	turns: SessionTurn[];
}

// Legacy path: data/users/<userId>/chatbot/conversation/sessions/<sessionId>.md
const LEGACY_SESSION: TestSession = {
	meta: makeSessionFrontmatter({
		id: 'legacy-session-001',
		user_id: 'user-alice',
		title: 'Alice discusses pasta',
		started_at: '2026-01-10T10:00:00Z',
		ended_at: '2026-01-10T10:30:00Z',
	}),
	turns: [
		makeTurn('user', 'I love pasta carbonara with guanciale', '2026-01-10T10:01:00Z'),
		makeTurn(
			'assistant',
			'Pasta carbonara is a classic Roman dish. The guanciale adds rich flavor.',
			'2026-01-10T10:01:05Z',
		),
		makeTurn('user', 'What about the cheese?', '2026-01-10T10:02:00Z'),
		makeTurn(
			'assistant',
			'Pecorino Romano is traditional, though Parmesan is often substituted.',
			'2026-01-10T10:02:05Z',
		),
	],
};

// Household path: data/households/<householdId>/users/<userId>/chatbot/conversation/sessions/<sessionId>.md
const HOUSEHOLD_SESSION: TestSession = {
	meta: makeSessionFrontmatter({
		id: 'household-session-001',
		user_id: 'user-bob',
		household_id: 'household-123',
		title: 'Bob asks about groceries',
		started_at: '2026-01-11T09:00:00Z',
		ended_at: '2026-01-11T09:15:00Z',
	}),
	turns: [
		makeTurn('user', 'We need to buy olive oil and tomatoes', '2026-01-11T09:01:00Z'),
		makeTurn(
			'assistant',
			'I can add olive oil and tomatoes to your grocery list.',
			'2026-01-11T09:01:05Z',
		),
		makeTurn('user', 'Also add garlic and basil', '2026-01-11T09:02:00Z'),
	],
};

// Second legacy session — used for the multi-session parity check
const LEGACY_SESSION_2: TestSession = {
	meta: makeSessionFrontmatter({
		id: 'legacy-session-002',
		user_id: 'user-alice',
		title: 'Alice asks about weather',
		started_at: '2026-01-12T08:00:00Z',
	}),
	turns: [
		makeTurn('user', 'What is the weather forecast for tomorrow?', '2026-01-12T08:01:00Z'),
		makeTurn(
			'assistant',
			'I do not have real-time weather data available.',
			'2026-01-12T08:01:05Z',
		),
	],
};

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedTranscripts(dataDir: string): Promise<void> {
	// Legacy session 1
	await writeTranscriptFile(
		join(
			dataDir,
			'users',
			'user-alice',
			'chatbot',
			'conversation',
			'sessions',
			'legacy-session-001.md',
		),
		buildTranscript(LEGACY_SESSION.meta, LEGACY_SESSION.turns),
	);

	// Legacy session 2
	await writeTranscriptFile(
		join(
			dataDir,
			'users',
			'user-alice',
			'chatbot',
			'conversation',
			'sessions',
			'legacy-session-002.md',
		),
		buildTranscript(LEGACY_SESSION_2.meta, LEGACY_SESSION_2.turns),
	);

	// Household session
	await writeTranscriptFile(
		join(
			dataDir,
			'households',
			'household-123',
			'users',
			'user-bob',
			'chatbot',
			'conversation',
			'sessions',
			'household-session-001.md',
		),
		buildTranscript(HOUSEHOLD_SESSION.meta, HOUSEHOLD_SESSION.turns),
	);
}

/**
 * Seeds the same data manually (as rows) into an existing index —
 * this is the "ground truth" we compare the rebuild against.
 */
async function seedIndex(index: ChatTranscriptIndexImpl): Promise<void> {
	// Legacy session 1
	await index.upsertSession(
		makeSessionRow({
			id: 'legacy-session-001',
			user_id: 'user-alice',
			title: 'Alice discusses pasta',
			started_at: '2026-01-10T10:00:00Z',
			ended_at: '2026-01-10T10:30:00Z',
		}),
	);
	const legacyTurns1 = LEGACY_SESSION.turns;
	for (let i = 0; i < legacyTurns1.length; i++) {
		await index.appendMessage(
			makeMessageRow({
				session_id: 'legacy-session-001',
				turn_index: i,
				role: legacyTurns1[i]!.role,
				content: legacyTurns1[i]!.content,
				timestamp: legacyTurns1[i]!.timestamp,
			}),
		);
	}

	// Legacy session 2
	await index.upsertSession(
		makeSessionRow({
			id: 'legacy-session-002',
			user_id: 'user-alice',
			title: 'Alice asks about weather',
			started_at: '2026-01-12T08:00:00Z',
		}),
	);
	const legacyTurns2 = LEGACY_SESSION_2.turns;
	for (let i = 0; i < legacyTurns2.length; i++) {
		await index.appendMessage(
			makeMessageRow({
				session_id: 'legacy-session-002',
				turn_index: i,
				role: legacyTurns2[i]!.role,
				content: legacyTurns2[i]!.content,
				timestamp: legacyTurns2[i]!.timestamp,
			}),
		);
	}

	// Household session
	await index.upsertSession(
		makeSessionRow({
			id: 'household-session-001',
			user_id: 'user-bob',
			household_id: 'household-123',
			title: 'Bob asks about groceries',
			started_at: '2026-01-11T09:00:00Z',
			ended_at: '2026-01-11T09:15:00Z',
		}),
	);
	const householdTurns = HOUSEHOLD_SESSION.turns;
	for (let i = 0; i < householdTurns.length; i++) {
		await index.appendMessage(
			makeMessageRow({
				session_id: 'household-session-001',
				turn_index: i,
				role: householdTurns[i]!.role,
				content: householdTurns[i]!.content,
				timestamp: householdTurns[i]!.timestamp,
			}),
		);
	}
}

// ---------------------------------------------------------------------------
// Query helper — extracts just the sessionIds from a search result for easy
// set comparison
// ---------------------------------------------------------------------------

async function searchSessionIds(
	index: ChatTranscriptIndexImpl,
	filters: InternalSearchFilters,
): Promise<string[]> {
	const result = await index.searchSessions(filters);
	return result.hits.map((h) => h.sessionId).sort();
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-rebuild-test-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Main parity test
// ---------------------------------------------------------------------------

describe('rebuildIndex parity', () => {
	test('rebuilt index returns the same search results as a manually-seeded index', async () => {
		const dataDir = join(tempDir, 'data');
		const groundTruthDb = join(tempDir, 'ground-truth.db');
		const rebuiltDb = join(tempDir, 'rebuilt.db');

		// 1. Seed transcript files on disk
		await seedTranscripts(dataDir);

		// 2. Seed ground-truth index manually (as rows)
		const groundTruth = new ChatTranscriptIndexImpl(groundTruthDb);
		await seedIndex(groundTruth);

		// 3. Run several searches on ground truth and capture results
		const queries: Array<{ filters: InternalSearchFilters; label: string }> = [
			{
				label: 'pasta (alice)',
				filters: {
					userId: 'user-alice',
					householdId: null,
					queryTerms: ['pasta'],
					limitSessions: 10,
				},
			},
			{
				label: 'carbonara (alice)',
				filters: {
					userId: 'user-alice',
					householdId: null,
					queryTerms: ['carbonara'],
					limitSessions: 10,
				},
			},
			{
				label: 'grocery olive oil (bob)',
				filters: {
					userId: 'user-bob',
					householdId: 'household-123',
					queryTerms: ['olive', 'oil'],
					limitSessions: 10,
				},
			},
			{
				label: 'weather (alice)',
				filters: {
					userId: 'user-alice',
					householdId: null,
					queryTerms: ['weather'],
					limitSessions: 10,
				},
			},
			{
				label: 'cross-user isolation: alice query returns nothing for bob',
				filters: {
					userId: 'user-bob',
					householdId: 'household-123',
					queryTerms: ['pasta'],
					limitSessions: 10,
				},
			},
		];

		const groundTruthResults: string[][] = [];
		for (const q of queries) {
			groundTruthResults.push(await searchSessionIds(groundTruth, q.filters));
		}
		await groundTruth.close();

		// 4. Run rebuildIndex — builds from the transcript files on disk
		const result = await rebuildIndex({ dbPath: rebuiltDb, dataDir });

		// 5. Verify summary counts
		expect(result.sessions).toBe(3);
		expect(result.turns).toBe(
			LEGACY_SESSION.turns.length + LEGACY_SESSION_2.turns.length + HOUSEHOLD_SESSION.turns.length,
		);
		expect(result.skipped).toBe(0);

		// 6. Open the rebuilt DB and run the same queries
		const rebuilt = new ChatTranscriptIndexImpl(rebuiltDb);
		try {
			for (let i = 0; i < queries.length; i++) {
				const rebuiltIds = await searchSessionIds(rebuilt, queries[i]!.filters);
				expect(rebuiltIds, `Query "${queries[i]!.label}" parity`).toEqual(groundTruthResults[i]);
			}
		} finally {
			await rebuilt.close();
		}
	});

	test('rebuilt index preserves household_id on session rows', async () => {
		const dataDir = join(tempDir, 'data');
		const rebuiltDb = join(tempDir, 'rebuilt.db');

		await seedTranscripts(dataDir);
		await rebuildIndex({ dbPath: rebuiltDb, dataDir });

		const rebuilt = new ChatTranscriptIndexImpl(rebuiltDb);
		try {
			const meta = await rebuilt.getSessionMeta('household-session-001');
			expect(meta).toBeDefined();
			expect(meta!.household_id).toBe('household-123');
			expect(meta!.user_id).toBe('user-bob');
		} finally {
			await rebuilt.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Corrupt file handling
// ---------------------------------------------------------------------------

describe('rebuildIndex corrupt file handling', () => {
	test('corrupt .md file is skipped without throwing', async () => {
		const dataDir = join(tempDir, 'data');
		const rebuiltDb = join(tempDir, 'rebuilt.db');

		// Seed one valid session
		await writeTranscriptFile(
			join(
				dataDir,
				'users',
				'user-alice',
				'chatbot',
				'conversation',
				'sessions',
				'valid-session.md',
			),
			buildTranscript(
				makeSessionFrontmatter({
					id: 'valid-session',
					user_id: 'user-alice',
					started_at: '2026-01-15T00:00:00Z',
				}),
				[makeTurn('user', 'Hello world', '2026-01-15T00:01:00Z')],
			),
		);

		// Write a corrupt .md file (missing frontmatter entirely)
		await writeTranscriptFile(
			join(
				dataDir,
				'users',
				'user-alice',
				'chatbot',
				'conversation',
				'sessions',
				'corrupt-session.md',
			),
			'this is not valid markdown frontmatter\nno yaml header present',
		);

		// Write another corrupt file (valid YAML front but no closing ---)
		await writeTranscriptFile(
			join(
				dataDir,
				'users',
				'user-alice',
				'chatbot',
				'conversation',
				'sessions',
				'truncated-session.md',
			),
			'---\nid: truncated\n', // no closing ---
		);

		const result = await rebuildIndex({ dbPath: rebuiltDb, dataDir });

		// Valid session indexed, 2 corrupt skipped
		expect(result.sessions).toBe(1);
		expect(result.skipped).toBe(2);

		// The valid session should be searchable
		const rebuilt = new ChatTranscriptIndexImpl(rebuiltDb);
		try {
			const meta = await rebuilt.getSessionMeta('valid-session');
			expect(meta).toBeDefined();
			expect(meta!.user_id).toBe('user-alice');
		} finally {
			await rebuilt.close();
		}
	});

	test('all corrupt files returns sessions=0, skipped=N', async () => {
		const dataDir = join(tempDir, 'data');
		const rebuiltDb = join(tempDir, 'rebuilt.db');

		await writeTranscriptFile(
			join(dataDir, 'users', 'user-x', 'chatbot', 'conversation', 'sessions', 'bad1.md'),
			'no frontmatter at all',
		);
		await writeTranscriptFile(
			join(dataDir, 'users', 'user-x', 'chatbot', 'conversation', 'sessions', 'bad2.md'),
			'---\nbroken: true\n',
		);

		const result = await rebuildIndex({ dbPath: rebuiltDb, dataDir });

		expect(result.sessions).toBe(0);
		expect(result.skipped).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

describe('rebuildIndex dry-run', () => {
	test('dry-run does not create a DB file but returns correct counts', async () => {
		const dataDir = join(tempDir, 'data');
		const dryRunDb = join(tempDir, 'dryrun.db');

		await seedTranscripts(dataDir);

		const result = await rebuildIndex({ dbPath: dryRunDb, dataDir, dryRun: true });

		// Counts should still be correct
		expect(result.sessions).toBe(3);
		expect(result.turns).toBe(
			LEGACY_SESSION.turns.length + LEGACY_SESSION_2.turns.length + HOUSEHOLD_SESSION.turns.length,
		);
		expect(result.skipped).toBe(0);

		// No DB file should have been written
		const { stat: statFn } = await import('node:fs/promises');
		await expect(statFn(dryRunDb)).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Empty data directory
// ---------------------------------------------------------------------------

describe('rebuildIndex empty/missing data dir', () => {
	test('empty data directory returns zeros without throwing', async () => {
		const dataDir = join(tempDir, 'empty-data');
		const rebuiltDb = join(tempDir, 'empty.db');

		// dataDir does not exist at all
		const result = await rebuildIndex({ dbPath: rebuiltDb, dataDir });

		expect(result.sessions).toBe(0);
		expect(result.turns).toBe(0);
		expect(result.skipped).toBe(0);
	});

	test('data dir exists but no users/households subdirs returns zeros', async () => {
		const dataDir = join(tempDir, 'data-empty');
		const rebuiltDb = join(tempDir, 'empty2.db');

		await mkdir(dataDir, { recursive: true });

		const result = await rebuildIndex({ dbPath: rebuiltDb, dataDir });

		expect(result.sessions).toBe(0);
		expect(result.turns).toBe(0);
		expect(result.skipped).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Idempotency (run rebuild twice on same DB)
// ---------------------------------------------------------------------------

describe('rebuildIndex idempotency', () => {
	test('running rebuild twice does not duplicate sessions or turns in search results', async () => {
		const dataDir = join(tempDir, 'data');
		const rebuiltDb = join(tempDir, 'rebuilt.db');

		await seedTranscripts(dataDir);

		await rebuildIndex({ dbPath: rebuiltDb, dataDir });
		// Second run deletes and recreates the DB from scratch — results are identical
		const result2 = await rebuildIndex({ dbPath: rebuiltDb, dataDir });

		expect(result2.sessions).toBe(3);
		expect(result2.skipped).toBe(0);

		const rebuilt = new ChatTranscriptIndexImpl(rebuiltDb);
		try {
			// Searching for "pasta" should still return exactly 1 session (not 2)
			const searchResult = await rebuilt.searchSessions({
				userId: 'user-alice',
				householdId: null,
				queryTerms: ['pasta'],
				limitSessions: 10,
			});
			expect(searchResult.hits).toHaveLength(1);
			expect(searchResult.hits[0]!.sessionId).toBe('legacy-session-001');
		} finally {
			await rebuilt.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Stale session reconciliation (derived-index invariant)
// ---------------------------------------------------------------------------

describe('rebuildIndex stale session reconciliation', () => {
	test('deleted .md file does not persist after rebuild', async () => {
		const dataDir = join(tempDir, 'data');
		const rebuiltDb = join(tempDir, 'rebuilt.db');

		await seedTranscripts(dataDir);

		// First rebuild — all 3 sessions indexed
		await rebuildIndex({ dbPath: rebuiltDb, dataDir });
		const index1 = new ChatTranscriptIndexImpl(rebuiltDb);
		const hitsBefore = await index1.searchSessions({
			userId: 'user-alice',
			householdId: null,
			queryTerms: ['pasta'],
			limitSessions: 10,
		});
		expect(hitsBefore.hits).toHaveLength(1);
		await index1.close();

		// Delete the .md file for the pasta session
		await unlink(
			join(
				dataDir,
				'users',
				'user-alice',
				'chatbot',
				'conversation',
				'sessions',
				'legacy-session-001.md',
			),
		);

		// Rebuild again — stale session must be gone
		const result2 = await rebuildIndex({ dbPath: rebuiltDb, dataDir });
		expect(result2.sessions).toBe(2); // only 2 files left
		expect(result2.skipped).toBe(0);

		const index2 = new ChatTranscriptIndexImpl(rebuiltDb);
		try {
			const hitsAfter = await index2.searchSessions({
				userId: 'user-alice',
				householdId: null,
				queryTerms: ['pasta'],
				limitSessions: 10,
			});
			expect(hitsAfter.hits).toHaveLength(0);
		} finally {
			await index2.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Frontmatter ownership trust (path is authoritative)
// ---------------------------------------------------------------------------

describe('rebuildIndex ownership validation', () => {
	test('file whose frontmatter user_id disagrees with path is skipped', async () => {
		const dataDir = join(tempDir, 'data');
		const rebuiltDb = join(tempDir, 'rebuilt.db');

		// Write a session under user-alice's path but with user_id: 'user-eve' in frontmatter
		await writeTranscriptFile(
			join(
				dataDir,
				'users',
				'user-alice',
				'chatbot',
				'conversation',
				'sessions',
				'tampered-session.md',
			),
			buildTranscript(
				makeSessionFrontmatter({
					id: 'tampered-session',
					user_id: 'user-eve', // disagrees with path (user-alice)
					started_at: '2026-01-20T00:00:00Z',
				}),
				[makeTurn('user', 'Sensitive info from Eve', '2026-01-20T00:01:00Z')],
			),
		);

		const result = await rebuildIndex({ dbPath: rebuiltDb, dataDir });

		// The tampered file must be skipped
		expect(result.skipped).toBe(1);
		expect(result.sessions).toBe(0);

		const rebuilt = new ChatTranscriptIndexImpl(rebuiltDb);
		try {
			// Neither user-alice nor user-eve should see the tampered session
			const aliceHits = await rebuilt.searchSessions({
				userId: 'user-alice',
				householdId: null,
				queryTerms: ['sensitive', 'eve'],
				limitSessions: 10,
			});
			expect(aliceHits.hits).toHaveLength(0);

			const eveHits = await rebuilt.searchSessions({
				userId: 'user-eve',
				householdId: null,
				queryTerms: ['sensitive', 'eve'],
				limitSessions: 10,
			});
			expect(eveHits.hits).toHaveLength(0);
		} finally {
			await rebuilt.close();
		}
	});

	test('file whose frontmatter id disagrees with filename is skipped', async () => {
		const dataDir = join(tempDir, 'data');
		const rebuiltDb = join(tempDir, 'rebuilt.db');

		await writeTranscriptFile(
			join(
				dataDir,
				'users',
				'user-alice',
				'chatbot',
				'conversation',
				'sessions',
				'filename-session.md',
			),
			buildTranscript(
				makeSessionFrontmatter({
					id: 'different-id', // disagrees with filename 'filename-session'
					user_id: 'user-alice',
					started_at: '2026-01-21T00:00:00Z',
				}),
				[makeTurn('user', 'Some content', '2026-01-21T00:01:00Z')],
			),
		);

		const result = await rebuildIndex({ dbPath: rebuiltDb, dataDir });
		expect(result.skipped).toBe(1);
		expect(result.sessions).toBe(0);
	});
});
