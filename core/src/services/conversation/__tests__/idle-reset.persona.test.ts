/**
 * Persona tests for idle-reset (Hermes P8a Chunk A).
 *
 * These tests simulate real user scenarios:
 * - User returns after a long break
 * - User returns mid-task (active-work protection)
 * - Should NOT trigger reset (within threshold, at threshold)
 * - Disabled by config
 * - All entry points participate
 */

import { describe, expect, it, vi } from 'vitest';
import { runIdleResetHook } from '../idle-reset-hook.js';
import { RECENT_SESSION_SUMMARY_KEY } from '../memory-flush.js';
import { pendingEdits } from '../pending-edits.js';
import { createPendingSessionControlStore } from '../pending-session-control-store.js';

// ---------------------------------------------------------------------------
// Shared mock factory
// ---------------------------------------------------------------------------

const BASE_NOW = new Date('2026-05-04T14:00:00.000Z');

function makeSession(lastActivity: string, title: string | null = null) {
	return {
		id: 'session-abc',
		meta: {
			id: 'session-abc',
			source: 'telegram' as const,
			user_id: 'u1',
			household_id: null,
			model: null,
			title,
			parent_session_id: null,
			started_at: '2026-05-04T10:00:00.000Z',
			last_activity_at: lastActivity,
			ended_at: null,
			token_counts: { input: 0, output: 0 },
		},
		turns: [],
	};
}

function makeDeps(opts: {
	idleMinutes: number | null | undefined;
	lastActivity: string;
	title?: string | null;
	now?: Date;
	pendingSessionControl?: ReturnType<typeof createPendingSessionControlStore>;
	turns?: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
}) {
	const session = makeSession(opts.lastActivity, opts.title ?? null);
	if (opts.turns) session.turns = opts.turns;
	return {
		idleMinutes: opts.idleMinutes,
		now: () => opts.now ?? BASE_NOW,
		chatSessions: {
			peekActive: vi.fn().mockResolvedValue(session.id),
			readSession: vi.fn().mockResolvedValue(session),
			endActive: vi.fn().mockResolvedValue({ endedSessionId: session.id }),
		},
		telegram: { send: vi.fn().mockResolvedValue(undefined) },
		logger: { warn: vi.fn() },
		pendingSessionControl: opts.pendingSessionControl,
	};
}

const BASE_CTX = { userId: 'u1' };

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('Idle-reset persona scenarios', () => {
	describe('User returns after a long break', () => {
		it('"hey are you still there?" after 25 hours → idle notice sent + session ended', async () => {
			const deps = makeDeps({
				idleMinutes: 720, // 12-hour threshold
				lastActivity: '2026-05-03T13:00:00.000Z', // 25 hours ago
				now: BASE_NOW,
			});
			const result = await runIdleResetHook(BASE_CTX, deps);
			expect(result.status).toBe('reset');
			expect(deps.chatSessions.endActive).toHaveBeenCalledWith(
				expect.objectContaining({ userId: 'u1' }),
				'idle',
			);
			expect(deps.telegram.send).toHaveBeenCalledWith('u1', expect.stringContaining('inactivity'));
		});

		it('"good morning" after 12h exactly does NOT reset (exclusive threshold)', async () => {
			const deps = makeDeps({
				idleMinutes: 720, // exactly 720 minutes
				lastActivity: '2026-05-04T02:00:00.000Z', // exactly 720 min ago from 14:00
				now: BASE_NOW,
			});
			const result = await runIdleResetHook(BASE_CTX, deps);
			expect(result.status).toBe('none'); // exclusive boundary
			expect(deps.chatSessions.endActive).not.toHaveBeenCalled();
		});

		it('back-to-back messages within threshold → no reset', async () => {
			const deps = makeDeps({
				idleMinutes: 60,
				lastActivity: '2026-05-04T13:30:00.000Z', // 30 min ago, under 60-min threshold
				now: BASE_NOW,
			});
			const result = await runIdleResetHook(BASE_CTX, deps);
			expect(result.status).toBe('none');
			expect(deps.telegram.send).not.toHaveBeenCalled();
		});

		it('parentTitle is returned so successor session can inherit lineage', async () => {
			const deps = makeDeps({
				idleMinutes: 60,
				lastActivity: '2026-05-04T12:00:00.000Z', // 2h ago
				title: 'weekend trip planning',
				now: BASE_NOW,
			});
			const result = await runIdleResetHook(BASE_CTX, deps);
			expect(result.status).toBe('reset');
			expect(result.parentTitle).toBe('weekend trip planning');
		});
	});

	describe('User returns mid-task (active-work protection)', () => {
		it('"add bread to the list" after 2h while pendingEdit is active → no reset (protected)', async () => {
			// biome-ignore lint/suspicious/noExplicitAny: test-only sentinel value
			pendingEdits.set('u1', {} as any);
			try {
				const deps = makeDeps({
					idleMinutes: 60,
					lastActivity: '2026-05-04T12:00:00.000Z', // 2h ago
					now: BASE_NOW,
				});
				const result = await runIdleResetHook(BASE_CTX, deps);
				expect(result.status).toBe('protected');
				expect(deps.chatSessions.endActive).not.toHaveBeenCalled();
				expect(deps.telegram.send).not.toHaveBeenCalled();
			} finally {
				pendingEdits.delete('u1');
			}
		});

		it('grey-zone /newchat buttons pending → no reset (protected)', async () => {
			const sc = createPendingSessionControlStore();
			sc.attach('u1', {
				userId: 'u1',
				messageText: 'start fresh?',
				expiresAt: Date.now() + 60_000,
				id: 'nonce1',
			});
			const deps = makeDeps({
				idleMinutes: 60,
				lastActivity: '2026-05-04T12:00:00.000Z',
				now: BASE_NOW,
				pendingSessionControl: sc,
			});
			const result = await runIdleResetHook(BASE_CTX, deps);
			expect(result.status).toBe('protected');
			expect(deps.chatSessions.endActive).not.toHaveBeenCalled();
		});
	});

	describe('Should NOT trigger reset', () => {
		it.each([
			['within threshold: 30 min elapsed vs 60-min threshold', '2026-05-04T13:30:00.000Z', 60],
			['at threshold exactly: 60 min elapsed vs 60-min threshold', '2026-05-04T13:00:00.000Z', 60],
			[
				'at threshold exactly: 720 min elapsed vs 720-min threshold',
				'2026-05-04T02:00:00.000Z',
				720,
			],
		])('%s', async (_label, lastActivity, idleMinutes) => {
			const deps = makeDeps({ idleMinutes, lastActivity, now: BASE_NOW });
			const result = await runIdleResetHook(BASE_CTX, deps);
			expect(result.status).toBe('none');
			expect(deps.chatSessions.endActive).not.toHaveBeenCalled();
		});
	});

	describe('Disabled by config', () => {
		it('auto_reset_idle_minutes=null → no reset ever, even after 7 days', async () => {
			const deps = makeDeps({
				idleMinutes: null,
				lastActivity: '2026-04-27T14:00:00.000Z', // 7 days ago
				now: BASE_NOW,
			});
			const result = await runIdleResetHook(BASE_CTX, deps);
			expect(result.status).toBe('none');
			expect(deps.chatSessions.endActive).not.toHaveBeenCalled();
			expect(deps.telegram.send).not.toHaveBeenCalled();
		});

		it('auto_reset_idle_minutes=undefined → no reset', async () => {
			const deps = makeDeps({
				idleMinutes: undefined,
				lastActivity: '2026-04-27T14:00:00.000Z',
				now: BASE_NOW,
			});
			const result = await runIdleResetHook(BASE_CTX, deps);
			expect(result.status).toBe('none');
		});
	});

	describe('Duration message formatting in idle notice', () => {
		it.each([
			[1, '2026-05-04T13:58:59.000Z', '1 minute'],
			[30, '2026-05-04T13:29:59.000Z', '30 minutes'],
			[60, '2026-05-04T12:59:59.000Z', '1 hour'],
			[120, '2026-05-04T11:59:59.000Z', '2 hours'],
			[1440, '2026-05-03T13:59:59.000Z', '1 day'],
			[2880, '2026-05-02T13:59:59.000Z', '2 days'],
		])(
			'%d-minute threshold → "%s" in notice',
			async (idleMinutes, lastActivity, expectedDuration) => {
				const deps = makeDeps({ idleMinutes, lastActivity, now: BASE_NOW });
				const result = await runIdleResetHook(BASE_CTX, deps);
				expect(result.status).toBe('reset');
				expect(deps.telegram.send).toHaveBeenCalledWith(
					'u1',
					expect.stringContaining(expectedDuration),
				);
			},
		);
	});

	// ── P8b persona scenarios (hook-level) ───────────────────────────────────

	describe('S2 — Summarizer fails: idle reset still completes, user notified', () => {
		it('summaryStatus="failed" when summarizer throws — user is still notified', async () => {
			const turns = [
				{ role: 'user' as const, content: 'hello', timestamp: '2026-05-04T12:00:00.000Z' },
				{ role: 'assistant' as const, content: 'hi', timestamp: '2026-05-04T12:00:01.000Z' },
			];
			const deps = {
				...makeDeps({
					idleMinutes: 60,
					lastActivity: '2026-05-04T12:00:00.000Z',
					now: BASE_NOW,
					turns,
				}),
				summarizer: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
				flushSave: vi.fn().mockResolvedValue(undefined),
				getFlushEnabled: vi.fn().mockResolvedValue(true),
			};

			const result = await runIdleResetHook(BASE_CTX, deps);

			expect(result.status).toBe('reset');
			expect(result.summaryStatus).toBe('failed');
			expect(deps.telegram.send).toHaveBeenCalledWith('u1', expect.stringContaining('inactivity'));
			expect(deps.flushSave).not.toHaveBeenCalled();
		});
	});

	describe('S3 — Flush disabled: toggle off suppresses summarizer', () => {
		it('summaryStatus="disabled" when getFlushEnabled returns false, summarizer never called', async () => {
			const turns = [
				{ role: 'user' as const, content: 'hello', timestamp: '2026-05-04T12:00:00.000Z' },
				{ role: 'assistant' as const, content: 'hi', timestamp: '2026-05-04T12:00:01.000Z' },
			];
			const summarizer = vi.fn().mockResolvedValue('summary');
			const deps = {
				...makeDeps({
					idleMinutes: 60,
					lastActivity: '2026-05-04T12:00:00.000Z',
					now: BASE_NOW,
					turns,
				}),
				summarizer,
				flushSave: vi.fn().mockResolvedValue(undefined),
				getFlushEnabled: vi.fn().mockResolvedValue(false),
			};

			const result = await runIdleResetHook(BASE_CTX, deps);

			expect(result.status).toBe('reset');
			expect(result.summaryStatus).toBe('disabled');
			expect(summarizer).not.toHaveBeenCalled();
		});
	});

	describe('S6 — Empty session: summarizer skipped for sessions with < 2 turns', () => {
		it('summaryStatus="skipped" when session has 1 turn', async () => {
			const turns = [
				{ role: 'user' as const, content: 'hello', timestamp: '2026-05-04T12:00:00.000Z' },
			];
			const summarizer = vi.fn().mockResolvedValue('summary');
			const deps = {
				...makeDeps({
					idleMinutes: 60,
					lastActivity: '2026-05-04T12:00:00.000Z',
					now: BASE_NOW,
					turns,
				}),
				summarizer,
				flushSave: vi.fn().mockResolvedValue(undefined),
				getFlushEnabled: vi.fn().mockResolvedValue(true),
			};

			const result = await runIdleResetHook(BASE_CTX, deps);

			expect(result.status).toBe('reset');
			expect(result.summaryStatus).toBe('skipped');
			expect(summarizer).not.toHaveBeenCalled();
		});

		it('summaryStatus="skipped" when session has 0 turns', async () => {
			const summarizer = vi.fn().mockResolvedValue('summary');
			const deps = {
				...makeDeps({
					idleMinutes: 60,
					lastActivity: '2026-05-04T12:00:00.000Z',
					now: BASE_NOW,
					turns: [],
				}),
				summarizer,
				flushSave: vi.fn().mockResolvedValue(undefined),
				getFlushEnabled: vi.fn().mockResolvedValue(true),
			};

			const result = await runIdleResetHook(BASE_CTX, deps);

			expect(result.status).toBe('reset');
			expect(result.summaryStatus).toBe('skipped');
			expect(summarizer).not.toHaveBeenCalled();
		});
	});

	describe('S7 — Rolling key: second idle reset overwrites first (hook-level)', () => {
		it('flushSave is called on each reset — overwrite is enforced by key strategy', async () => {
			const turns = [
				{ role: 'user' as const, content: 'hi', timestamp: '2026-05-04T12:00:00.000Z' },
				{ role: 'assistant' as const, content: 'hey', timestamp: '2026-05-04T12:00:01.000Z' },
			];
			const flushSave = vi.fn().mockResolvedValue(undefined);

			for (const summaryText of ['First summary.', 'Second summary.']) {
				const deps = {
					...makeDeps({
						idleMinutes: 60,
						lastActivity: '2026-05-04T12:00:00.000Z',
						now: BASE_NOW,
						turns,
					}),
					summarizer: vi.fn().mockResolvedValue(summaryText),
					flushSave,
					getFlushEnabled: vi.fn().mockResolvedValue(true),
				};
				await runIdleResetHook(BASE_CTX, deps);
			}

			// Both calls use the same key
			expect(flushSave).toHaveBeenCalledTimes(2);
			expect(flushSave).toHaveBeenNthCalledWith(
				1,
				'u1',
				RECENT_SESSION_SUMMARY_KEY,
				'First summary.',
			);
			expect(flushSave).toHaveBeenNthCalledWith(
				2,
				'u1',
				RECENT_SESSION_SUMMARY_KEY,
				'Second summary.',
			);
		});
	});

	it.todo('S8 — group-chat session keys (deferred to P3 group-chat work)');
});
