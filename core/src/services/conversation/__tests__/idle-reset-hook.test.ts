import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdleResetState } from '../../../types/conversation-session.js';
import { runIdleResetHook } from '../idle-reset-hook.js';
import { RECENT_SESSION_SUMMARY_KEY } from '../memory-flush.js';
import { pendingEdits } from '../pending-edits.js';
import { createPendingSessionControlStore } from '../pending-session-control-store.js';

const baseCtx = { userId: 'u1' };

function makeDeps(opts: {
	idleMinutes?: number | null;
	activeSession?: { id: string; last_activity_at?: string; title: string | null } | null;
	now?: Date;
	pendingSessionControl?: ReturnType<typeof createPendingSessionControlStore>;
}) {
	return {
		idleMinutes: opts.idleMinutes ?? null,
		now: () => opts.now ?? new Date('2026-05-01T14:00:00Z'),
		chatSessions: {
			peekActive: vi.fn().mockResolvedValue(opts.activeSession?.id ?? undefined),
			readSession: vi.fn().mockResolvedValue(
				opts.activeSession
					? {
							meta: {
								id: opts.activeSession.id,
								last_activity_at: opts.activeSession.last_activity_at,
								started_at: '2026-05-01T12:00:00Z',
								title: opts.activeSession.title,
								ended_at: null,
							},
							turns: [],
						}
					: undefined,
			),
			endActive: vi.fn().mockResolvedValue({ endedSessionId: opts.activeSession?.id ?? null }),
		},
		telegram: { send: vi.fn().mockResolvedValue(undefined) },
		logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
		pendingSessionControl: opts.pendingSessionControl,
	};
}

describe('summaryStatus', () => {
	it('IdleResetState type carries summaryStatus literal union (compile-time)', () => {
		const a: IdleResetState = { status: 'reset', endedSessionId: 'x', summaryStatus: 'disabled' };
		const b: IdleResetState = { status: 'reset', endedSessionId: 'x', summaryStatus: 'timeout' };
		expect(a.summaryStatus).toBe('disabled');
		expect(b.summaryStatus).toBe('timeout');
	});
});

describe('runIdleResetHook', () => {
	describe('disabled / no-op paths', () => {
		it('status="none" when idleMinutes is null', async () => {
			const deps = makeDeps({ idleMinutes: null });
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('none');
			expect(deps.chatSessions.endActive).not.toHaveBeenCalled();
		});
		it('status="none" when idleMinutes is undefined', async () => {
			const deps = makeDeps({});
			// idleMinutes defaults to null in makeDeps — either null or undefined → 'none'
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('none');
		});
		it('status="none" when no active session', async () => {
			const deps = makeDeps({ idleMinutes: 60, activeSession: null });
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('none');
		});
		it('status="none" when session is not idle (1 min before threshold)', async () => {
			const deps = makeDeps({
				idleMinutes: 120,
				activeSession: { id: 's1', last_activity_at: '2026-05-01T12:01:00Z', title: null },
				now: new Date('2026-05-01T14:00:00Z'), // 119 min elapsed, not idle
			});
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('none');
		});
		it('status="none" at exactly the threshold (exclusive boundary)', async () => {
			const deps = makeDeps({
				idleMinutes: 120,
				activeSession: { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: null },
				now: new Date('2026-05-01T14:00:00Z'), // exactly 120 min = NOT idle
			});
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('none');
		});
	});

	describe('happy path', () => {
		it('status="reset", returns endedSessionId + parentTitle, ends session, notifies user', async () => {
			const deps = makeDeps({
				idleMinutes: 120,
				activeSession: {
					id: 's1',
					last_activity_at: '2026-05-01T12:00:00Z',
					title: 'shopping list',
				},
				now: new Date('2026-05-01T14:00:01Z'), // 120 min + 1ms = idle
			});
			const result = await runIdleResetHook(baseCtx, deps);
			// P8b adds summaryStatus:'disabled' when no flush deps — use toMatchObject
			expect(result).toMatchObject({
				status: 'reset',
				endedSessionId: 's1',
				parentTitle: 'shopping list',
			});
			expect(deps.chatSessions.endActive).toHaveBeenCalledWith(
				expect.objectContaining({ userId: 'u1' }),
				'idle',
			);
			expect(deps.telegram.send).toHaveBeenCalledWith('u1', expect.stringMatching(/inactivity/));
		});
		it('parentTitle is null when session has no title', async () => {
			const deps = makeDeps({
				idleMinutes: 60,
				activeSession: { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: null },
				now: new Date('2026-05-01T13:01:00Z'),
			});
			const result = await runIdleResetHook(baseCtx, deps);
			expect(result.parentTitle).toBeNull();
		});
	});

	describe('formatDuration in notification message', () => {
		const ACTIVE = { id: 's1', last_activity_at: '2026-05-01T00:00:00Z', title: null };
		it.each([
			[1, '2026-05-01T00:01:01Z', '1 minute'],
			[30, '2026-05-01T00:30:01Z', '30 minutes'],
			[60, '2026-05-01T01:00:01Z', '1 hour'],
			[90, '2026-05-01T01:30:01Z', '1 hour 30 minutes'],
			[120, '2026-05-01T02:00:01Z', '2 hours'],
			[150, '2026-05-01T02:30:01Z', '2 hours 30 minutes'],
			[1440, '2026-05-02T00:00:01Z', '1 day'],
			[1470, '2026-05-02T00:30:01Z', '1 day 30 minutes'],
			[1500, '2026-05-02T01:00:01Z', '1 day 1 hour'],
			[2880, '2026-05-03T00:00:01Z', '2 days'],
		])('%d minutes → "%s"', async (idleMinutes, nowIso, expected) => {
			const deps = makeDeps({ idleMinutes, activeSession: ACTIVE, now: new Date(nowIso) });
			await runIdleResetHook(baseCtx, deps);
			expect(deps.telegram.send).toHaveBeenCalledWith('u1', expect.stringContaining(expected));
		});
	});

	describe('active-work protection', () => {
		it('status="protected" when pending session-control entry is present', async () => {
			const sc = createPendingSessionControlStore();
			// Attach a non-expired entry
			sc.attach('u1', { userId: 'u1', messageText: '', expiresAt: Date.now() + 60_000, id: 'n1' });
			const deps = makeDeps({
				idleMinutes: 60,
				activeSession: { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: null },
				now: new Date('2026-05-01T13:01:00Z'),
				pendingSessionControl: sc,
			});
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('protected');
			expect(deps.chatSessions.endActive).not.toHaveBeenCalled();
		});
		it('status="protected" when pending edit is present', async () => {
			// biome-ignore lint/suspicious/noExplicitAny: test-only sentinel value
			pendingEdits.set('u1', {} as any);
			try {
				const deps = makeDeps({
					idleMinutes: 60,
					activeSession: { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: null },
					now: new Date('2026-05-01T13:01:00Z'),
				});
				expect((await runIdleResetHook(baseCtx, deps)).status).toBe('protected');
				expect(deps.chatSessions.endActive).not.toHaveBeenCalled();
			} finally {
				pendingEdits.delete('u1');
			}
		});
	});

	describe('fail-open coverage (every boundary)', () => {
		it('peekActive throw → status="none", warn logged, no endActive call', async () => {
			const deps = makeDeps({
				idleMinutes: 60,
				activeSession: { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: null },
				now: new Date('2026-05-01T13:01:00Z'),
			});
			vi.mocked(deps.chatSessions.peekActive).mockRejectedValueOnce(new Error('peek fail'));
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('none');
			expect(deps.logger.warn).toHaveBeenCalled();
			expect(deps.chatSessions.endActive).not.toHaveBeenCalled();
		});
		it('readSession throw → status="none", warn logged', async () => {
			const deps = makeDeps({
				idleMinutes: 60,
				activeSession: { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: null },
				now: new Date('2026-05-01T13:01:00Z'),
			});
			vi.mocked(deps.chatSessions.readSession).mockRejectedValueOnce(new Error('read fail'));
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('none');
			expect(deps.logger.warn).toHaveBeenCalled();
		});
		it('endActive throw → status="none", warn logged, NO telegram.send', async () => {
			const deps = makeDeps({
				idleMinutes: 60,
				activeSession: { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: null },
				now: new Date('2026-05-01T13:01:00Z'),
			});
			vi.mocked(deps.chatSessions.endActive).mockRejectedValueOnce(new Error('disk full'));
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('none');
			expect(deps.telegram.send).not.toHaveBeenCalled();
			expect(deps.logger.warn).toHaveBeenCalled();
		});
		it('telegram.send throw → status stays "reset" (session already ended)', async () => {
			const deps = makeDeps({
				idleMinutes: 60,
				activeSession: { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: null },
				now: new Date('2026-05-01T13:01:00Z'),
			});
			vi.mocked(deps.telegram.send).mockRejectedValueOnce(new Error('telegram down'));
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('reset');
		});
		it('endActive returns null (concurrent race) → status="none", warn logged, NO telegram.send', async () => {
			const deps = makeDeps({
				idleMinutes: 60,
				activeSession: { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: null },
				now: new Date('2026-05-01T13:01:00Z'),
			});
			// Simulate concurrent race: another handler cleared the active session first
			vi.mocked(deps.chatSessions.endActive).mockResolvedValueOnce({ endedSessionId: null });
			expect((await runIdleResetHook(baseCtx, deps)).status).toBe('none');
			expect(deps.logger.warn).toHaveBeenCalled();
			expect(deps.telegram.send).not.toHaveBeenCalled();
		});
	});
});

// ── P8b flush integration tests ─────────────────────────────────────────────

const IDLE_SESSION = { id: 's1', last_activity_at: '2026-05-01T12:00:00Z', title: 'test session' };
const IDLE_NOW = new Date('2026-05-01T13:01:00Z');
const IDLE_OPTS = { idleMinutes: 60, activeSession: IDLE_SESSION, now: IDLE_NOW };

// 4-turn session (2 pairs) — enough for summarizer
const FOUR_TURNS = [
	{ role: 'user' as const, content: 'hello', timestamp: '2026-05-01T12:00:00Z' },
	{ role: 'assistant' as const, content: 'hi there', timestamp: '2026-05-01T12:01:00Z' },
	{ role: 'user' as const, content: 'how are you', timestamp: '2026-05-01T12:02:00Z' },
	{ role: 'assistant' as const, content: 'good thanks', timestamp: '2026-05-01T12:03:00Z' },
];

function makeIdleDepsWithTurns(turns: typeof FOUR_TURNS) {
	return {
		...IDLE_OPTS,
		readSession: { turns },
	};
}

function makeFlushDeps(overrides?: {
	summarizerResult?: string | null | (() => Promise<string | null>);
	flushSaveResult?: 'ok' | 'throw';
	getFlushEnabledResult?: boolean | 'throw';
	flushTimeoutMs?: number;
	turns?: typeof FOUR_TURNS;
}) {
	const {
		summarizerResult = 'Alice prefers tea.',
		flushSaveResult = 'ok',
		getFlushEnabledResult = true,
		flushTimeoutMs = 8_000,
		turns = FOUR_TURNS,
	} = overrides ?? {};

	const base = makeDeps({
		idleMinutes: 60,
		activeSession: {
			...IDLE_SESSION,
			// Inject turns into readSession mock
		},
		now: IDLE_NOW,
	});

	// Override readSession to return turns
	vi.mocked(base.chatSessions.readSession).mockResolvedValue({
		meta: {
			id: IDLE_SESSION.id,
			last_activity_at: IDLE_SESSION.last_activity_at,
			started_at: '2026-05-01T12:00:00Z',
			title: IDLE_SESSION.title,
			ended_at: null,
		},
		turns,
	});

	const summarizer =
		typeof summarizerResult === 'function'
			? vi.fn().mockImplementation(summarizerResult)
			: vi.fn().mockResolvedValue(summarizerResult);

	const flushSave =
		flushSaveResult === 'throw'
			? vi.fn().mockRejectedValue(new Error('save failed'))
			: vi.fn().mockResolvedValue(undefined);

	const getFlushEnabled =
		getFlushEnabledResult === 'throw'
			? vi.fn().mockRejectedValue(new Error('config error'))
			: vi.fn().mockResolvedValue(getFlushEnabledResult);

	return {
		...base,
		summarizer,
		flushSave,
		getFlushEnabled,
		flushTimeoutMs,
	};
}

describe('P8b: summaryStatus branches', () => {
	it('summaryStatus="written" on happy path with flush enabled + 4-turn session', async () => {
		const deps = makeFlushDeps();
		const result = await runIdleResetHook(baseCtx, deps);
		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('written');
		expect(deps.flushSave).toHaveBeenCalledWith('u1', RECENT_SESSION_SUMMARY_KEY, expect.any(String));
	});

	it('summaryStatus="disabled" when getFlushEnabled returns false', async () => {
		const deps = makeFlushDeps({ getFlushEnabledResult: false });
		const result = await runIdleResetHook(baseCtx, deps);
		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('disabled');
		expect(deps.summarizer).not.toHaveBeenCalled();
		expect(deps.flushSave).not.toHaveBeenCalled();
	});

	it('summaryStatus="disabled" when no flush deps provided', async () => {
		const deps = makeDeps(IDLE_OPTS);
		const result = await runIdleResetHook(baseCtx, deps);
		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('disabled');
	});

	it('summaryStatus="skipped" when session has < 2 turns', async () => {
		const deps = makeFlushDeps({ turns: [FOUR_TURNS[0]!] });
		const result = await runIdleResetHook(baseCtx, deps);
		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('skipped');
		expect(deps.summarizer).not.toHaveBeenCalled();
	});

	it('summaryStatus="skipped" when summarizer returns null', async () => {
		const deps = makeFlushDeps({ summarizerResult: null });
		const result = await runIdleResetHook(baseCtx, deps);
		expect(result.summaryStatus).toBe('skipped');
		expect(deps.flushSave).not.toHaveBeenCalled();
	});

	it('summaryStatus="failed" when summarizer throws — idle reset still proceeds', async () => {
		const deps = makeFlushDeps({
			summarizerResult: () => Promise.reject(new Error('model error')),
		});
		const result = await runIdleResetHook(baseCtx, deps);
		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('failed');
		expect(deps.logger.warn).toHaveBeenCalled();
	});

	it('summaryStatus="failed" when flushSave throws', async () => {
		const deps = makeFlushDeps({ flushSaveResult: 'throw' });
		const result = await runIdleResetHook(baseCtx, deps);
		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('failed');
	});

	it('summaryStatus="failed" when getFlushEnabled throws (fail-open)', async () => {
		const deps = makeFlushDeps({ getFlushEnabledResult: 'throw' });
		const result = await runIdleResetHook(baseCtx, deps);
		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('failed');
		expect(deps.logger.warn).toHaveBeenCalled();
	});
});

describe('P8b: endActive CAS ordering', () => {
	it('endActive runs BEFORE summarize (CAS-first ordering)', async () => {
		const callOrder: string[] = [];
		const deps = makeFlushDeps();
		vi.mocked(deps.chatSessions.endActive).mockImplementation(async (...args) => {
			callOrder.push('endActive');
			return { endedSessionId: IDLE_SESSION.id };
		});
		deps.summarizer.mockImplementation(async () => {
			callOrder.push('summarizer');
			return 'summary text';
		});
		await runIdleResetHook(baseCtx, deps);
		expect(callOrder.indexOf('endActive')).toBeLessThan(callOrder.indexOf('summarizer'));
	});

	it('two concurrent hooks for same user — CAS ensures only one summarizes', async () => {
		const deps1 = makeFlushDeps();
		const deps2 = makeFlushDeps();
		// Second hook's endActive loses the CAS race (returns null)
		vi.mocked(deps2.chatSessions.endActive).mockResolvedValueOnce({ endedSessionId: null });

		await Promise.all([
			runIdleResetHook(baseCtx, deps1),
			runIdleResetHook(baseCtx, deps2),
		]);

		// Only the CAS winner (deps1) summarizes; deps2 returned status='none'
		expect(deps1.summarizer).toHaveBeenCalledTimes(1);
		expect(deps2.summarizer).not.toHaveBeenCalled();
	});
});

describe('P8b: timeout behavior', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('summaryStatus="timeout" when summarize+save exceeds flushTimeoutMs', async () => {
		const deps = makeFlushDeps({
			summarizerResult: () => new Promise(() => {}), // never resolves
			flushTimeoutMs: 100,
		});
		const promise = runIdleResetHook(baseCtx, deps);
		await vi.advanceTimersByTimeAsync(150);
		const result = await promise;
		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('timeout');
		expect(deps.flushSave).not.toHaveBeenCalled();
	});
});
