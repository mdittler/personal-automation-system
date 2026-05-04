import type { IdleResetState } from '../../types/conversation-session.js';

export function parentSessionFromIdleReset(s: IdleResetState | undefined): string | null {
	return s?.status === 'reset' ? (s.endedSessionId ?? null) : null;
}
