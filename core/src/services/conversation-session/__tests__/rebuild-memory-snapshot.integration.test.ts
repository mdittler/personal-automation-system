/**
 * Integration test for ChatSessionStore.rebuildMemorySnapshot.
 *
 * Uses a real temp directory and real store. Verifies that a successful
 * rebuild updates memory_snapshot in the frontmatter on disk while
 * preserving all other fields.
 *
 * REQ-CONV-MEMORY-013, REQ-CONV-MEMORY-020, REQ-CONV-MEMORY-022
 */

import { rm } from 'node:fs/promises';
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
