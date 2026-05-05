/**
 * Integration test for ChatSessionStore.rebuildMemorySnapshot.
 *
 * Uses a real temp directory and real store. Verifies that a successful
 * rebuild updates memory_snapshot in the frontmatter on disk while
 * preserving all other fields.
 *
 * REQ-CONV-MEMORY-013, REQ-CONV-MEMORY-020, REQ-CONV-MEMORY-022
 */

import { readFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemorySnapshot } from '../../../types/conversation-session.js';
import { NoActiveSessionError } from '../errors.js';
import { makeStoreFixture } from './fixtures.js';

const USER = 'integration-user';
const SESSION_KEY = `agent:main:telegram:dm:${USER}`;
const ctx = { userId: USER, sessionKey: SESSION_KEY };

describe('rebuild-memory-snapshot integration', () => {
	const fixtures: Array<{ tempDir: string }> = [];

	afterEach(async () => {
		for (const f of fixtures.splice(0)) {
			await rm(f.tempDir, { recursive: true, force: true });
		}
	});

	it('writes new snapshot to disk and preserves all other frontmatter fields', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		const { meta: before } = await f.readDecoded(USER, sessionId!);

		const builtSnapshot: MemorySnapshot = {
			content: 'test-pref: X\ndietary: vegan',
			status: 'ok',
			builtAt: '2026-05-05T10:00:00.000Z',
			entryCount: 2,
		};

		const result = await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => builtSnapshot,
			expectedSessionId: sessionId!,
		});

		// Returned snapshot matches what buildSnapshot produced
		expect(result.content).toContain('test-pref');
		expect(result.content).toContain('X');
		expect(result.entryCount).toBe(2);

		// Disk state updated
		const { meta: after } = await f.readDecoded(USER, sessionId!);
		expect(after.memory_snapshot?.content).toContain('test-pref');
		expect(after.memory_snapshot?.content).toContain('X');
		expect(after.memory_snapshot?.entry_count).toBe(2);
		expect(after.memory_snapshot?.built_at).toBe('2026-05-05T10:00:00.000Z');

		// Preserved fields
		expect(after.id).toBe(before.id);
		expect(after.source).toBe(before.source);
		expect(after.user_id).toBe(before.user_id);
		expect(after.started_at).toBe(before.started_at);
		expect(after.token_counts).toEqual(before.token_counts);
	});

	it('second rebuild reflects updated snapshot content', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => ({
				content: 'preference: dark-mode',
				status: 'ok',
				builtAt: '2026-05-05T10:00:00.000Z',
				entryCount: 1,
			}),
			expectedSessionId: sessionId!,
		});

		// Simulate context change: now rebuild with updated preference
		await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => ({
				content: 'preference: light-mode',
				status: 'ok',
				builtAt: '2026-05-05T11:00:00.000Z',
				entryCount: 1,
			}),
			expectedSessionId: sessionId!,
		});

		const { meta } = await f.readDecoded(USER, sessionId!);
		expect(meta.memory_snapshot?.content).toBe('preference: light-mode');
		// Always-persist: built_at reflects second rebuild
		expect(meta.memory_snapshot?.built_at).toBe('2026-05-05T11:00:00.000Z');
	});

	it('throws NoActiveSessionError when no session exists', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);

		await expect(
			f.store.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => ({
					content: 'test',
					status: 'ok',
					builtAt: '2026-05-05T10:00:00.000Z',
					entryCount: 1,
				}),
			}),
		).rejects.toThrow(NoActiveSessionError);
	});
});

// ─── REQ-CONV-MEMORY-022: prefix-cache stability amendment ────────────────────
//
// The Layer 1+2 bytes are stable across turns BETWEEN /refreshmemory events
// (i.e., without a rebuild the transcript raw bytes do not change).
// AFTER a rebuild, the bytes DO change (snapshot is updated).

describe('REQ-CONV-MEMORY-022 — prefix-cache byte-stability without rebuild', () => {
	const fixtures: Array<{ tempDir: string }> = [];

	afterEach(async () => {
		for (const f of fixtures.splice(0)) {
			await rm(f.tempDir, { recursive: true, force: true });
		}
	});

	it('transcript bytes are identical after two appendExchange calls with no rebuild', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		const sessionPath = join(
			f.tempDir,
			'users',
			USER,
			'chatbot',
			'conversation',
			'sessions',
			`${sessionId}.md`,
		);

		// Read bytes after first exchange (already appended by ensure())
		const bytes1 = await readFile(sessionPath);

		// Append another exchange without rebuilding
		await f.store.appendExchange(
			ctx,
			{ role: 'user', content: 'hello again', timestamp: new Date().toISOString() },
			{ role: 'assistant', content: 'hi again', timestamp: new Date().toISOString() },
		);
		const bytes2 = await readFile(sessionPath);

		// The frontmatter section should remain byte-identical (new turns only appended after)
		// Verify that the raw bytes differ only in the appended turns (not the frontmatter blob)
		const raw1 = bytes1.toString('utf-8');
		const raw2 = bytes2.toString('utf-8');
		// raw2 extends raw1 (turns appended) — the prefix up to raw1.length is identical
		expect(raw2.startsWith(raw1)).toBe(true);
	});

	it('transcript bytes change after a successful rebuild (byte-difference assertion)', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		const sessionPath = join(
			f.tempDir,
			'users',
			USER,
			'chatbot',
			'conversation',
			'sessions',
			`${sessionId}.md`,
		);

		const bytesBefore = await readFile(sessionPath);

		await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => ({
				content: 'updated-pref: new-value',
				status: 'ok',
				builtAt: '2026-05-05T12:00:00.000Z',
				entryCount: 1,
			}),
			expectedSessionId: sessionId!,
		});

		const bytesAfter = await readFile(sessionPath);
		// Must differ — snapshot was written
		expect(bytesAfter.equals(bytesBefore)).toBe(false);
		// New snapshot content appears in the file
		expect(bytesAfter.toString('utf-8')).toContain('updated-pref');
	});
});
