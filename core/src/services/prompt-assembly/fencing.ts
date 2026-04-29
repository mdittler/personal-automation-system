/**
 * Conversation-history framing helpers.
 * Last 4 turns get [Recent]; earlier turns get [Earlier]. Kept bit-for-bit
 * identical to pre-P0 chatbot behavior (apps/chatbot/src/index.ts:533).
 */
import { formatRelativeTime } from '../../utils/cron-describe.js';
import type { SessionTurn as ConversationTurn } from '../conversation-session/chat-session-store.js';
import { sanitizeInput } from './sanitization.js';

/**
 * Exact-string whitelist for photo-summary user turns.
 * Only these literal strings lift the per-turn truncation cap to PHOTO_TURN_CAP.
 * Any other content (including user-crafted "[Photo: ...]" strings) stays at
 * HISTORY_TURN_CAP, preventing cap-lifting via spoofed photo headers.
 */
const PHOTO_TURN_HEADERS = new Set([
	'[Photo: receipt]',
	'[Photo: recipe]',
	'[Photo: pantry]',
	'[Photo: grocery list]',
]);

const HISTORY_TURN_CAP = 500;
const PHOTO_TURN_CAP = 2000;

export function formatConversationHistory(
	turns: ConversationTurn[],
	now: Date = new Date(),
): string[] {
	const recentCutoff = turns.length - 4;
	return turns.map((turn, i) => {
		const role = turn.role === 'user' ? 'User' : 'Assistant';
		const recencyTag = i >= recentCutoff ? '[Recent]' : '[Earlier]';
		const timePart = turn.timestamp
			? ` (${formatRelativeTime(new Date(turn.timestamp), now)})`
			: '';
		// Photo-summary pair detection (exact-string whitelist, anti-spoof):
		// - user turn: content is exactly one of the whitelisted headers
		// - assistant turn: the preceding user turn was a whitelisted header
		const isPhotoUser = turn.role === 'user' && PHOTO_TURN_HEADERS.has(turn.content);
		const prev = turns[i - 1];
		const isPhotoAssistant =
			turn.role === 'assistant' &&
			prev?.role === 'user' &&
			PHOTO_TURN_HEADERS.has(prev.content);
		const cap = isPhotoUser || isPhotoAssistant ? PHOTO_TURN_CAP : HISTORY_TURN_CAP;
		return `- ${recencyTag}${timePart} ${role}: ${sanitizeInput(turn.content, cap)}`;
	});
}
