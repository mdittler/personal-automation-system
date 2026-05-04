import { describe, expect, it, vi } from 'vitest';
import { runIdleResetHook } from '../idle-reset-hook.js';
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
			expect(result).toEqual({
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
