/**
 * Persistence tests for InteractionContextServiceImpl.
 *
 * Tests cover disk round-trips, corrupt-file handling, debounced flush
 * coalescing, TTL-aware pruning on load, and in-memory mode.
 */

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite } from '../../../utils/file.js';
import { InteractionContextServiceImpl } from '../index.js';
import type { InteractionEntry } from '../index.js';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Build a minimal mock logger with spies. */
function makeMockLogger() {
	return {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};
}

/** Build a valid InteractionEntry fixture. */
function makeEntry(overrides: Partial<InteractionEntry> = {}): InteractionEntry {
	return {
		appId: 'food',
		action: 'capture-receipt',
		filePaths: ['users/user1/food/receipts/2026-04.md'],
		scope: 'user',
		timestamp: Date.now(),
		...overrides,
	};
}

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-interaction-'));
	vi.useRealTimers();
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(tempDir, { recursive: true, force: true });
});

describe('InteractionContextService persistence', () => {
	// ─── Test 1 ───────────────────────────────────────────────────────────────
	it('reload restores entries written by a prior instance', async () => {
		// Instance A: record + flush to disk
		const a = new InteractionContextServiceImpl({
			dataDir: tempDir,
			writer: atomicWrite,
			flushDelayMs: 0,
		});
		a.record('user1', { appId: 'food', action: 'capture-receipt' });
		await a.flush();

		// Instance B: load from same dir
		const b = new InteractionContextServiceImpl({ dataDir: tempDir });
		await b.loadFromDisk();

		const entries = b.getRecent('user1');
		expect(entries).toHaveLength(1);
		expect(entries[0]!.action).toBe('capture-receipt');
	});

	// ─── Test 2 ───────────────────────────────────────────────────────────────
	it('expired entries are dropped on load', async () => {
		const now = Date.now();
		const persistPath = join(tempDir, 'system', 'interaction-context.json');
		await mkdir(join(tempDir, 'system'), { recursive: true });

		// Write entry with timestamp beyond TTL
		const expired = makeEntry({ timestamp: now - TTL_MS - 1000 });
		await writeFile(
			persistPath,
			JSON.stringify({ version: 1, users: { user1: [expired] } }),
			'utf-8',
		);

		const svc = new InteractionContextServiceImpl({ dataDir: tempDir });
		await svc.loadFromDisk();

		expect(svc.getRecent('user1')).toEqual([]);
	});

	// ─── Test 3 ───────────────────────────────────────────────────────────────
	it('per-user isolation is preserved across reload', async () => {
		const writerSpy = vi.fn(atomicWrite);
		const a = new InteractionContextServiceImpl({
			dataDir: tempDir,
			writer: writerSpy,
			flushDelayMs: 0,
		});

		a.record('alice', { appId: 'food', action: 'view-recipe' });
		a.record('bob', { appId: 'notes', action: 'create-note' });
		await a.flush();

		const b = new InteractionContextServiceImpl({ dataDir: tempDir });
		await b.loadFromDisk();

		const aliceEntries = b.getRecent('alice');
		const bobEntries = b.getRecent('bob');

		expect(aliceEntries).toHaveLength(1);
		expect(aliceEntries[0]!.action).toBe('view-recipe');
		expect(bobEntries).toHaveLength(1);
		expect(bobEntries[0]!.action).toBe('create-note');

		// No cross-contamination
		expect(aliceEntries.find((e) => e.action === 'create-note')).toBeUndefined();
		expect(bobEntries.find((e) => e.action === 'view-recipe')).toBeUndefined();
	});

	// ─── Test 4 ───────────────────────────────────────────────────────────────
	it('buffer cap of 5 is enforced on load (keep newest)', async () => {
		const now = Date.now();
		const persistPath = join(tempDir, 'system', 'interaction-context.json');
		await mkdir(join(tempDir, 'system'), { recursive: true });

		// Write 7 valid entries with ascending timestamps
		const entries: InteractionEntry[] = Array.from({ length: 7 }, (_, i) =>
			makeEntry({ action: `action-${i + 1}`, timestamp: now + i * 1000 }),
		);
		await writeFile(
			persistPath,
			JSON.stringify({ version: 1, users: { user1: entries } }),
			'utf-8',
		);

		const svc = new InteractionContextServiceImpl({ dataDir: tempDir });
		await svc.loadFromDisk();

		const recent = svc.getRecent('user1');
		expect(recent).toHaveLength(5);
		// Should keep newest 5 (action-3 through action-7), newest-first
		expect(recent[0]!.action).toBe('action-7');
		expect(recent[4]!.action).toBe('action-3');
		expect(recent.find((e) => e.action === 'action-1')).toBeUndefined();
		expect(recent.find((e) => e.action === 'action-2')).toBeUndefined();
	});

	// ─── Test 5 ───────────────────────────────────────────────────────────────
	it('missing file starts empty without error', async () => {
		// tempDir exists but has no interaction-context.json
		const svc = new InteractionContextServiceImpl({ dataDir: tempDir });
		await expect(svc.loadFromDisk()).resolves.toBeUndefined();
		expect(svc.getRecent('user1')).toEqual([]);
	});

	// ─── Test 6 ───────────────────────────────────────────────────────────────
	it('corrupt JSON creates .corrupt sidecar and starts empty', async () => {
		const persistPath = join(tempDir, 'system', 'interaction-context.json');
		await mkdir(join(tempDir, 'system'), { recursive: true });
		await writeFile(persistPath, 'NOT VALID JSON {{{', 'utf-8');

		const logger = makeMockLogger();
		const svc = new InteractionContextServiceImpl({ dataDir: tempDir, logger: logger as any });
		await expect(svc.loadFromDisk()).resolves.toBeUndefined();

		// Entries empty
		expect(svc.getRecent('user1')).toEqual([]);

		// Sidecar exists
		const systemDir = join(tempDir, 'system');
		const files = await import('node:fs/promises').then((m) => m.readdir(systemDir));
		const corruptFiles = files.filter((f) => f.includes('.corrupt'));
		expect(corruptFiles.length).toBeGreaterThan(0);

		// Logger warned
		expect(logger.warn).toHaveBeenCalled();
	});

	// ─── Test 7 ───────────────────────────────────────────────────────────────
	it('invalid entries are dropped during load, valid ones kept', async () => {
		const now = Date.now();
		const persistPath = join(tempDir, 'system', 'interaction-context.json');
		await mkdir(join(tempDir, 'system'), { recursive: true });

		const users = {
			user1: [
				// valid
				makeEntry({ action: 'valid-action', timestamp: now }),
				// bad scope
				{ appId: 'food', action: 'bad-scope', scope: 'invalid-scope', filePaths: [], timestamp: now + 1 },
				// non-array filePaths
				{ appId: 'food', action: 'bad-paths', scope: 'user', filePaths: 'not-an-array', timestamp: now + 2 },
				// missing timestamp
				{ appId: 'food', action: 'no-timestamp', scope: 'user', filePaths: [] },
			],
		};
		await writeFile(persistPath, JSON.stringify({ version: 1, users }), 'utf-8');

		const logger = makeMockLogger();
		const svc = new InteractionContextServiceImpl({ dataDir: tempDir, logger: logger as any });
		await svc.loadFromDisk();

		const entries = svc.getRecent('user1');
		expect(entries).toHaveLength(1);
		expect(entries[0]!.action).toBe('valid-action');

		// Should warn about dropped entries
		expect(logger.warn).toHaveBeenCalled();
	});

	// ─── Test 8 ───────────────────────────────────────────────────────────────
	it('unknown version starts empty with a warning', async () => {
		const persistPath = join(tempDir, 'system', 'interaction-context.json');
		await mkdir(join(tempDir, 'system'), { recursive: true });
		await writeFile(
			persistPath,
			JSON.stringify({ version: 99, users: {} }),
			'utf-8',
		);

		const logger = makeMockLogger();
		const svc = new InteractionContextServiceImpl({ dataDir: tempDir, logger: logger as any });
		await svc.loadFromDisk();

		expect(svc.getRecent('user1')).toEqual([]);
		expect(logger.warn).toHaveBeenCalled();
	});

	// ─── Test 9 ───────────────────────────────────────────────────────────────
	it('debounced flush coalesces multiple rapid records into one write', async () => {
		const writerSpy = vi.fn().mockResolvedValue(undefined);

		const svc = new InteractionContextServiceImpl({
			dataDir: tempDir,
			writer: writerSpy,
			flushDelayMs: 500,
		});

		// Record 5 times quickly (all within the debounce window)
		for (let i = 0; i < 5; i++) {
			svc.record('user1', { appId: 'food', action: `action-${i}` });
		}

		// Writer should not have been called yet (debounce hasn't fired)
		expect(writerSpy).not.toHaveBeenCalled();

		// flush() cancels any pending timer and immediately writes once
		await svc.flush();

		// Only one write should have occurred (all 5 records coalesced)
		expect(writerSpy).toHaveBeenCalledTimes(1);
	});

	// ─── Test 10 ──────────────────────────────────────────────────────────────
	it('records during in-flight flush are captured by automatic follow-up flush', async () => {
		// Verify the automatic follow-up flush path:
		// When record() is called WHILE a flush is in-flight (i.e. the writer is
		// blocked), the post-flush check (revision > flushedRevision) auto-enqueues
		// a follow-up flush WITHOUT any explicit flush() call, so both entries
		// land on disk.

		// 1. Create a deferred promise that blocks the first writer call
		let resolveFirstWrite!: () => void;
		const blockFirstWrite = new Promise<void>((r) => {
			resolveFirstWrite = r;
		});

		let writeCount = 0;
		// Writer: block on first call, use atomicWrite on subsequent calls
		const writer = vi.fn().mockImplementation(async (path: string, content: string) => {
			writeCount++;
			if (writeCount === 1) {
				await blockFirstWrite;
			}
			await atomicWrite(path, content);
		});

		const svc = new InteractionContextServiceImpl({
			dataDir: tempDir,
			writer,
			flushDelayMs: 0,
		});

		// 2. record() → schedules a debounced flush (flushDelayMs=0, fires on next tick)
		svc.record('user1', { appId: 'food', action: 'first' });

		// 3. Yield to the event loop so the debounce timer fires and the first
		//    _doFlush begins executing — it will block inside the writer
		await new Promise<void>((r) => setTimeout(r, 10));

		// 4. While first flush is still in-flight (blocked), call record() again.
		//    This bumps revision above flushedRevision (which is still 0).
		svc.record('user1', { appId: 'food', action: 'second' });

		// 5. Unblock the first writer — first flush completes, detects
		//    revision > flushedRevision, and auto-enqueues a follow-up flush
		resolveFirstWrite();

		// 6. Wait for the write queue to fully drain (first flush + follow-up flush).
		//    No explicit flush() call is needed — the follow-up is automatic.
		await new Promise<void>((r) => setTimeout(r, 50));

		// 7. Reload from disk — BOTH entries must be present
		const b = new InteractionContextServiceImpl({ dataDir: tempDir });
		await b.loadFromDisk();
		const actions = b.getRecent('user1').map((e) => e.action);
		expect(actions).toContain('first');
		expect(actions).toContain('second');

		// Writer was called at least twice: the first flush plus the automatic
		// follow-up that fired because revision > flushedRevision after the first
		// flush completed. (A third write from the debounce timer that record()
		// schedules is also acceptable — what matters is the follow-up mechanism.)
		expect(writer.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	// ─── Test 11 ──────────────────────────────────────────────────────────────
	it('flush() cancels debounce and writes immediately without waiting for timer', async () => {
		vi.useFakeTimers();
		const writerSpy = vi.fn().mockResolvedValue(undefined);

		const svc = new InteractionContextServiceImpl({
			dataDir: tempDir,
			writer: writerSpy,
			flushDelayMs: 5000,
		});

		svc.record('user1', { appId: 'food', action: 'immediate' });

		// Flush immediately — no timer advance
		await svc.flush();

		// Writer should have been called exactly once without advancing timers
		expect(writerSpy).toHaveBeenCalledTimes(1);
	});

	// ─── Test 12 ──────────────────────────────────────────────────────────────
	it('stop() drains pending writes; records after stop() do not schedule new flushes', async () => {
		vi.useFakeTimers();
		const writerSpy = vi.fn(atomicWrite);

		const svc = new InteractionContextServiceImpl({
			dataDir: tempDir,
			writer: writerSpy,
			flushDelayMs: 5000,
		});

		svc.record('user1', { appId: 'food', action: 'pre-stop' });

		// Stop before debounce fires — should flush the pending record
		await svc.stop();

		// Verify data was written
		const b = new InteractionContextServiceImpl({ dataDir: tempDir });
		await b.loadFromDisk();
		expect(b.getRecent('user1').map((e) => e.action)).toContain('pre-stop');

		// Now record after stop
		const callCountAfterStop = writerSpy.mock.calls.length;
		svc.record('user1', { appId: 'food', action: 'post-stop' });

		// Advance timers — no new flush should fire
		await vi.advanceTimersByTimeAsync(10000);
		expect(writerSpy.mock.calls.length).toBe(callCountAfterStop);
	});

	// ─── Test 13 ──────────────────────────────────────────────────────────────
	it('background flush failure is logged and does not throw from record()', async () => {
		const writerSpy = vi.fn().mockRejectedValue(new Error('disk full'));
		const logger = makeMockLogger();

		const svc = new InteractionContextServiceImpl({
			dataDir: tempDir,
			writer: writerSpy,
			flushDelayMs: 500,
			logger: logger as any,
		});

		// record() must not throw
		expect(() => svc.record('user1', { appId: 'food', action: 'will-fail' })).not.toThrow();

		// flush() triggers _doFlush which calls the rejecting writer.
		// The error is caught inside enqueueFlush's .catch() → _logFlushError.
		// flush() awaits writeQueue which resolves after the catch handler,
		// so this call does NOT rethrow.
		await svc.flush();

		// Logger must emit at error level (not just warn) for flush failures
		const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
		expect(errorCalls.length).toBeGreaterThan(0);
	});

	// ─── Test 14 ──────────────────────────────────────────────────────────────
	it('in-memory mode (no dataDir): record/getRecent work, lifecycle methods resolve', async () => {
		const svc = new InteractionContextServiceImpl();

		// In-memory operations work normally
		svc.record('user1', { appId: 'food', action: 'view-recipe' });
		const entries = svc.getRecent('user1');
		expect(entries).toHaveLength(1);
		expect(entries[0]!.action).toBe('view-recipe');

		// Lifecycle methods resolve without error
		await expect(svc.loadFromDisk()).resolves.toBeUndefined();
		await expect(svc.flush()).resolves.toBeUndefined();
		await expect(svc.stop()).resolves.toBeUndefined();
	});

	// ─── Test 15 ──────────────────────────────────────────────────────────────
	it('empty users are pruned from serialized JSON when all entries expire', async () => {
		let fakeNow = Date.now();
		const clock = () => fakeNow;

		const capturedJson: string[] = [];
		const writerSpy = vi.fn().mockImplementation(async (_path: string, content: string) => {
			capturedJson.push(content);
		});

		const svc = new InteractionContextServiceImpl({
			dataDir: tempDir,
			writer: writerSpy,
			clock,
			flushDelayMs: 0,
		});

		svc.record('alice', { appId: 'food', action: 'test' });

		// Advance fake clock past TTL so entry is expired
		fakeNow += TTL_MS + 1000;

		// Flush — pruneExpired runs at flush time using our clock
		await svc.flush();

		// At least one write should have occurred
		expect(writerSpy).toHaveBeenCalled();

		// Find the last written JSON (the one after TTL advance)
		const lastJson = capturedJson[capturedJson.length - 1]!;
		const parsed = JSON.parse(lastJson) as { version: number; users: Record<string, unknown> };

		// 'alice' should be absent — user pruned because no unexpired entries remain
		expect(Object.keys(parsed.users)).not.toContain('alice');
	});
});
