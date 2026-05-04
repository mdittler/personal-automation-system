import type { Logger } from 'pino';
import type {
	ChatSessionStore,
	ChatSessionFrontmatter,
	SessionTurn,
} from '../conversation-session/chat-session-store.js';
import type { PendingSessionControlStore } from './pending-session-control-store.js';
import { isIdle, getLastActivityIso } from '../conversation-session/idle-detector.js';
import { resolveOrDefaultSessionKey } from '../conversation-session/session-key.js';
import { pendingEdits } from './pending-edits.js';
import type { IdleResetState, IdleResetStatus } from '../../types/conversation-session.js';

export type { IdleResetStatus, IdleResetState };

export interface IdleResetHookDeps {
	idleMinutes: number | null | undefined;
	chatSessions: Pick<ChatSessionStore, 'peekActive' | 'readSession' | 'endActive'>;
	telegram: { send(userId: string, message: string): Promise<void> };
	logger: Pick<Logger, 'warn'>;
	pendingSessionControl?: PendingSessionControlStore;
	now?: () => Date;
}

export async function runIdleResetHook(
	ctx: { userId: string; sessionKey?: string },
	deps: IdleResetHookDeps,
): Promise<IdleResetState> {
	if (deps.idleMinutes == null) return { status: 'none' };

	const sessionKey = resolveOrDefaultSessionKey(ctx);
	const userId = ctx.userId;

	let activeId: string | undefined;
	try {
		activeId = await deps.chatSessions.peekActive({ userId, sessionKey });
	} catch (err) {
		deps.logger.warn({ err, userId }, 'idle-reset-hook: peekActive failed; continuing as no-op');
		return { status: 'none' };
	}
	if (!activeId) return { status: 'none' };

	let session: { meta: ChatSessionFrontmatter; turns: SessionTurn[] } | undefined;
	try {
		session = await deps.chatSessions.readSession(userId, activeId);
	} catch (err) {
		deps.logger.warn(
			{ err, userId, sessionId: activeId },
			'idle-reset-hook: readSession failed; continuing as no-op',
		);
		return { status: 'none' };
	}
	if (!session) return { status: 'none' };

	const now = deps.now?.() ?? new Date();
	const lastActivity = getLastActivityIso(session.meta);
	if (!isIdle(lastActivity, now, deps.idleMinutes)) return { status: 'none' };

	if (deps.pendingSessionControl?.has(userId)) return { status: 'protected' };
	if (pendingEdits.has(userId)) return { status: 'protected' };

	let resolvedSessionId: string | null;
	try {
		const result = await deps.chatSessions.endActive(
			{ userId, sessionKey, expectedSessionId: activeId },
			'idle',
		);
		resolvedSessionId = result.endedSessionId;
	} catch (err) {
		deps.logger.warn(
			{ err, userId, sessionId: activeId },
			'idle-reset-hook: endActive failed; aborting reset',
		);
		return { status: 'none' };
	}
	if (resolvedSessionId === null) {
		deps.logger.warn(
			{ userId, sessionId: activeId },
			'idle-reset-hook: endActive returned null (concurrent race); aborting reset',
		);
		return { status: 'none' };
	}

	const friendly = formatDuration(deps.idleMinutes);
	try {
		await deps.telegram.send(
			userId,
			`Previous conversation ended after ${friendly} of inactivity. Started a new session — ask me to recall anything from before.`,
		);
	} catch (err) {
		deps.logger.warn({ err, userId }, 'idle-reset-hook: notify failed; continuing');
	}

	return {
		status: 'reset',
		endedSessionId: resolvedSessionId,
		parentTitle: session.meta.title,
	};
}

function formatDuration(minutes: number): string {
	if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
	const d = Math.floor(minutes / 1440);
	const h = Math.floor((minutes % 1440) / 60);
	const m = minutes % 60;
	const parts: string[] = [];
	if (d > 0) parts.push(d === 1 ? '1 day' : `${d} days`);
	if (h > 0) parts.push(h === 1 ? '1 hour' : `${h} hours`);
	if (m > 0) parts.push(m === 1 ? '1 minute' : `${m} minutes`);
	return parts.join(' ');
}
