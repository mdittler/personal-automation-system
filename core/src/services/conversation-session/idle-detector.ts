import type { ChatSessionFrontmatter } from './chat-session-store.js';

/**
 * Read the effective last-activity timestamp from session frontmatter.
 * Legacy transcripts (pre-P8) lack `last_activity_at`; treat `started_at` as the floor.
 */
export function getLastActivityIso(meta: ChatSessionFrontmatter): string {
	return meta.last_activity_at ?? meta.started_at;
}

/**
 * Pure idle check. Returns true when (now - lastActivity) strictly exceeds idleMinutes.
 * Returns false on non-positive idleMinutes (treated as "disabled") or on unparseable input.
 */
export function isIdle(lastActivityIso: string, now: Date, idleMinutes: number): boolean {
	if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) return false;
	const last = Date.parse(lastActivityIso);
	if (Number.isNaN(last)) return false;
	const elapsedMs = now.getTime() - last;
	return elapsedMs > idleMinutes * 60_000;
}
