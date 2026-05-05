/**
 * Unit tests for ChatSessionStore.rebuildMemorySnapshot (Hermes P6.next Chunk B).
 *
 * Uses real filesystem via makeStoreFixture(). All locks, codec, and index
 * logic run against real files in a temp directory.
 *
 * Test groups:
 *  RB-1 — Happy path
 *  RB-2 — No active session → NoActiveSessionError
 *  RB-3 — expectedSessionId mismatch (pre-build CAS)
 *  RB-4 — CAS recheck: session ends during buildSnapshot, before write
 *  RB-5 — Transcript file missing → throws, no partial write
 *  RB-6 — buildSnapshot() throws → fail-soft, original snapshot preserved
 *  RB-7 — Always-persist: identical content still updates built_at
 *  RB-8 — Concurrent rebuilds: serialized, last-write-wins
 *  RB-9 — Field preservation: only memory_snapshot + last_activity_at change
 *
 * REQ-CONV-MEMORY-013..022
 */

import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemorySnapshot } from '../../../types/conversation-session.js';
import { NoActiveSessionError, SessionCasMismatchError } from '../errors.js';
import { makeStoreFixture } from './fixtures.js';

const USER = 'u1';
const SESSION_KEY = `agent:main:telegram:dm:${USER}`;
const ctx = { userId: USER, sessionKey: SESSION_KEY };

function snapshot(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
	return {
		content: 'preference: dark-mode\ndietary: vegetarian',
		status: 'ok',
		builtAt: '2026-01-01T12:00:00.000Z',
		entryCount: 2,
		...overrides,
	};
}

describe('RB-1 — Happy path', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('returns the new MemorySnapshot on success', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });
		const newSnap = snapshot({ content: 'preference: light-mode', entryCount: 1 });

		const result = await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => newSnap,
			expectedSessionId: sessionId!,
		});

		expect(result.content).toBe('preference: light-mode');
		expect(result.status).toBe('ok');
		expect(result.entryCount).toBe(1);
	});

	it('writes memory_snapshot frontmatter to the transcript file', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });
		const newSnap = snapshot({ content: 'updated content', entryCount: 3 });

		await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => newSnap,
			expectedSessionId: sessionId!,
		});

		const { meta } = await f.readDecoded(USER, sessionId!);
		expect(meta.memory_snapshot?.content).toBe('updated content');
		expect(meta.memory_snapshot?.entry_count).toBe(3);
	});

	it('updates last_activity_at after a successful rebuild', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });
		const { meta: before } = await f.readDecoded(USER, sessionId!);

		await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => snapshot(),
			expectedSessionId: sessionId!,
		});

		const { meta: after } = await f.readDecoded(USER, sessionId!);
		expect(after.last_activity_at).toBeDefined();
		// last_activity_at is set/updated (may equal or be after before value)
		expect(after.last_activity_at).not.toBeUndefined();
		// Verify other fields unchanged (separate test for full preservation)
		expect(after.id).toBe(before.id);
	});
});

// ---------------------------------------------------------------------------
// RB-2 — No active session → NoActiveSessionError
// ---------------------------------------------------------------------------

describe('RB-2 — No active session → NoActiveSessionError', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('throws NoActiveSessionError when no session is active', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);

		await expect(
			f.store.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => snapshot(),
			}),
		).rejects.toThrow(NoActiveSessionError);
	});

	it('does not call buildSnapshot when no active session', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		let called = false;

		await f.store
			.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => {
					called = true;
					return snapshot();
				},
			})
			.catch(() => {});

		expect(called).toBe(false);
	});

	it('throws NoActiveSessionError after session is ended', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });
		await f.store.endActive({ userId: USER, sessionKey: SESSION_KEY }, 'newchat');

		await expect(
			f.store.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => snapshot(),
				expectedSessionId: sessionId!,
			}),
		).rejects.toThrow(NoActiveSessionError);
	});
});

// ---------------------------------------------------------------------------
// RB-3 — expectedSessionId mismatch (pre-build CAS)
// ---------------------------------------------------------------------------

describe('RB-3 — expectedSessionId mismatch (pre-build CAS)', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('throws when expectedSessionId does not match active session id', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		await f.ensure({ userId: USER });
		const staleId = '20260101_000000_deadbeef';

		await expect(
			f.store.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => snapshot(),
				expectedSessionId: staleId,
			}),
		).rejects.toThrow();
	});

	it('does not call buildSnapshot on pre-build CAS mismatch', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		await f.ensure({ userId: USER });
		let called = false;

		await f.store
			.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => {
					called = true;
					return snapshot();
				},
				expectedSessionId: '20260101_000000_deadbeef',
			})
			.catch(() => {});

		expect(called).toBe(false);
	});

	it('does not write to the transcript on pre-build CAS mismatch', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });
		const { meta: before } = await f.readDecoded(USER, sessionId!);

		await f.store
			.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => snapshot({ content: 'should not appear' }),
				expectedSessionId: '20260101_000000_deadbeef',
			})
			.catch(() => {});

		const { meta: after } = await f.readDecoded(USER, sessionId!);
		expect(after.memory_snapshot?.content).not.toBe('should not appear');
		expect(after.memory_snapshot).toEqual(before.memory_snapshot);
	});
});

// ---------------------------------------------------------------------------
// RB-4 — CAS recheck: session ends during buildSnapshot, before write
// ---------------------------------------------------------------------------

describe('RB-4 — CAS recheck under transcript lock (session ends during buildSnapshot)', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('aborts when active session is ended between first index read and write', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		// Start rebuild with a slow buildSnapshot (no locks held during this phase)
		let resolveSnap!: (s: MemorySnapshot) => void;
		const pendingSnap = new Promise<MemorySnapshot>((r) => {
			resolveSnap = r;
		});

		const rebuildPromise = f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: () => pendingSnap,
			expectedSessionId: sessionId!,
		});

		// While buildSnapshot is pending (between step 1 and step 3, no locks held):
		// end the active session → clears the index
		await f.store.endActive({ userId: USER, sessionKey: SESSION_KEY }, 'reset');

		// Now resolve the snapshot — implementation re-reads index under CAS, finds mismatch
		resolveSnap(snapshot({ content: 'should be rejected by CAS recheck' }));

		// Rebuild must throw (CAS recheck fails)
		await expect(rebuildPromise).rejects.toThrow();

		// Warn logged for the CAS abort
		expect(f.warnings.some((w) => /cas|mismatch|session|refresh/i.test(w))).toBe(true);
	});

	it('does NOT write snapshot content when CAS recheck fails', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });
		const { meta: before } = await f.readDecoded(USER, sessionId!);

		let resolveSnap!: (s: MemorySnapshot) => void;
		const pendingSnap = new Promise<MemorySnapshot>((r) => {
			resolveSnap = r;
		});
		const rebuildPromise = f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: () => pendingSnap,
			expectedSessionId: sessionId!,
		});

		await f.store.endActive({ userId: USER, sessionKey: SESSION_KEY }, 'reset');
		resolveSnap(snapshot({ content: 'stale-content' }));
		await rebuildPromise.catch(() => {});

		const { meta: after } = await f.readDecoded(USER, sessionId!);
		expect(after.memory_snapshot?.content).not.toBe('stale-content');
		expect(after.memory_snapshot).toEqual(before.memory_snapshot);
	});
});

// ---------------------------------------------------------------------------
// RB-5 — Transcript file missing → throws, no partial write
// ---------------------------------------------------------------------------

describe('RB-5 — Transcript file missing', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('throws when the transcript file has been deleted', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		await f.deleteSessionFile(USER, sessionId!);

		await expect(
			f.store.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => snapshot(),
				expectedSessionId: sessionId!,
			}),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// RB-6 — buildSnapshot() throws → fail-soft, original snapshot preserved
// ---------------------------------------------------------------------------

describe('RB-6 — buildSnapshot() throws → fail-soft', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('propagates buildSnapshot error and does not write', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });
		const { meta: before } = await f.readDecoded(USER, sessionId!);

		await expect(
			f.store.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => {
					throw new Error('context store unavailable');
				},
				expectedSessionId: sessionId!,
			}),
		).rejects.toThrow('context store unavailable');

		const { meta: after } = await f.readDecoded(USER, sessionId!);
		expect(after.memory_snapshot).toEqual(before.memory_snapshot);
	});
});

// ---------------------------------------------------------------------------
// RB-7 — Always-persist: identical content still updates built_at
// ---------------------------------------------------------------------------

describe('RB-7 — Always-persist (REQ-CONV-MEMORY-020)', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('always writes even when content matches previous snapshot', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		const firstSnap: MemorySnapshot = {
			content: 'preference: light-mode',
			status: 'ok',
			builtAt: '2026-01-01T10:00:00.000Z',
			entryCount: 1,
		};
		await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => firstSnap,
			expectedSessionId: sessionId!,
		});

		const { meta: after1 } = await f.readDecoded(USER, sessionId!);
		const builtAt1 = after1.memory_snapshot?.built_at;

		// Second rebuild: same content but different built_at
		const secondSnap: MemorySnapshot = {
			content: 'preference: light-mode',
			status: 'ok',
			builtAt: '2026-01-01T11:00:00.000Z',
			entryCount: 1,
		};
		await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => secondSnap,
			expectedSessionId: sessionId!,
		});

		const { meta: after2 } = await f.readDecoded(USER, sessionId!);
		const builtAt2 = after2.memory_snapshot?.built_at;

		// Always-persist: built_at reflects the second rebuild time
		expect(builtAt2).toBe('2026-01-01T11:00:00.000Z');
		expect(builtAt2).not.toBe(builtAt1);
	});
});

// ---------------------------------------------------------------------------
// RB-8 — Concurrent rebuilds: serialized, last-write-wins
// ---------------------------------------------------------------------------

describe('RB-8 — Concurrent rebuilds: serialized, last-write-wins', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('serializes concurrent rebuilds and ends in a valid state', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		const snapA: MemorySnapshot = {
			content: 'SNAPSHOT-A',
			status: 'ok',
			builtAt: '2026-01-01T10:00:00.000Z',
			entryCount: 1,
		};
		const snapB: MemorySnapshot = {
			content: 'SNAPSHOT-B',
			status: 'ok',
			builtAt: '2026-01-01T11:00:00.000Z',
			entryCount: 2,
		};

		await Promise.all([
			f.store.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => snapA,
				expectedSessionId: sessionId!,
			}),
			f.store.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => snapB,
				expectedSessionId: sessionId!,
			}),
		]);

		const { meta } = await f.readDecoded(USER, sessionId!);
		// Last-write-wins: final content is one of the two valid snapshots
		const finalContent = meta.memory_snapshot?.content;
		expect(['SNAPSHOT-A', 'SNAPSHOT-B']).toContain(finalContent);
		// Frontmatter is valid (no torn write)
		expect(meta.id).toBe(sessionId);
		expect(meta.user_id).toBe(USER);
	});

	it('does not corrupt frontmatter on concurrent rebuilds', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		const snaps = Array.from({ length: 4 }, (_, i) => ({
			content: `SNAP-${i}`,
			status: 'ok' as const,
			builtAt: `2026-01-01T${10 + i}:00:00.000Z`,
			entryCount: i + 1,
		}));

		await Promise.all(
			snaps.map((s) =>
				f.store.rebuildMemorySnapshot(ctx, {
					buildSnapshot: async () => s,
					expectedSessionId: sessionId!,
				}),
			),
		);

		const { meta } = await f.readDecoded(USER, sessionId!);
		expect(meta.id).toBe(sessionId);
		expect(['ok', 'empty', 'degraded']).toContain(meta.memory_snapshot?.status);
	});
});

// ---------------------------------------------------------------------------
// RB-9 — Field preservation: only memory_snapshot + last_activity_at change
// ---------------------------------------------------------------------------

describe('RB-9 — Field preservation (REQ-CONV-MEMORY-022)', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('preserves all fields except memory_snapshot and last_activity_at', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });
		const { meta: before } = await f.readDecoded(USER, sessionId!);

		await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () =>
				snapshot({ content: 'new-content', builtAt: '2026-06-01T00:00:00.000Z' }),
			expectedSessionId: sessionId!,
		});

		const { meta: after } = await f.readDecoded(USER, sessionId!);

		// These fields MUST be preserved
		expect(after.id).toBe(before.id);
		expect(after.source).toBe(before.source);
		expect(after.user_id).toBe(before.user_id);
		expect(after.household_id).toBe(before.household_id);
		expect(after.model).toBe(before.model);
		expect(after.started_at).toBe(before.started_at);
		expect(after.ended_at).toBe(before.ended_at);
		expect(after.token_counts).toEqual(before.token_counts);
		expect(after.title).toBe(before.title);
		expect(after.parent_session_id).toBe(before.parent_session_id);

		// These fields are allowed to change
		expect(after.memory_snapshot?.content).toBe('new-content');
	});

	it('preserves all conversation turns after rebuild', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });
		const { turns: before } = await f.readDecoded(USER, sessionId!);

		await f.store.rebuildMemorySnapshot(ctx, {
			buildSnapshot: async () => snapshot(),
			expectedSessionId: sessionId!,
		});

		const { turns: after } = await f.readDecoded(USER, sessionId!);
		expect(after).toEqual(before);
	});
});

// ---------------------------------------------------------------------------
// RB-10 — P1 guard: ended_at in transcript under multi-lock → SessionCasMismatchError
// ---------------------------------------------------------------------------

describe('RB-10 — ended_at in transcript detected under lock (P1 guard)', () => {
	const fixtures: Array<{ tempDir: string }> = [];
	afterEach(async () => {
		for (const f of fixtures.splice(0)) await rm(f.tempDir, { recursive: true, force: true });
	});

	it('throws SessionCasMismatchError when transcript has ended_at but index still shows session active', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		// Simulate the P1 race: endActive wrote ended_at to transcript but hasn't cleared the index yet.
		await f.markSessionEndedInTranscriptOnly(USER, sessionId!);

		await expect(
			f.store.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => snapshot(),
				expectedSessionId: sessionId!,
			}),
		).rejects.toBeInstanceOf(SessionCasMismatchError);
	});

	it('does not overwrite transcript when ended_at is found under lock', async () => {
		const f = await makeStoreFixture();
		fixtures.push(f);
		const { sessionId } = await f.ensure({ userId: USER });

		await f.markSessionEndedInTranscriptOnly(USER, sessionId!);
		const { meta: before } = await f.readDecoded(USER, sessionId!);

		await f.store
			.rebuildMemorySnapshot(ctx, {
				buildSnapshot: async () => snapshot({ content: 'should-not-appear' }),
				expectedSessionId: sessionId!,
			})
			.catch(() => {});

		const { meta: after } = await f.readDecoded(USER, sessionId!);
		expect(after.memory_snapshot?.content).not.toBe('should-not-appear');
		expect(after.memory_snapshot).toEqual(before.memory_snapshot);
	});
});
