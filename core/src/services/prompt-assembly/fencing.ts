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

const APP_HEADER_RE = /^\[App: [a-z0-9_-]{1,32}\] [a-z0-9_:-]{1,64}$/;

function isLegacyPhotoHeader(content: string): boolean {
	return PHOTO_TURN_HEADERS.has(content);
}
function isLegacyAppHeader(content: string): boolean {
	return APP_HEADER_RE.test(content);
}

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
		const prev = turns[i - 1];

		// Metadata-authoritative path (writes since 5a).
		const sourceLiftsUser =
			turn.role === 'user' && (turn.source === 'photo' || turn.source === 'app');
		const sourceLiftsAssistant =
			turn.role === 'assistant' && (prev?.source === 'photo' || prev?.source === 'app');

		// Legacy fallback: only when source is undefined on the relevant turn.
		const legacyLiftsUser =
			turn.role === 'user' &&
			turn.source === undefined &&
			(isLegacyPhotoHeader(turn.content) || isLegacyAppHeader(turn.content));
		const legacyLiftsAssistant =
			turn.role === 'assistant' &&
			prev?.role === 'user' &&
			prev?.source === undefined &&
			(isLegacyPhotoHeader(prev.content) || isLegacyAppHeader(prev.content));

		const cap =
			sourceLiftsUser || sourceLiftsAssistant || legacyLiftsUser || legacyLiftsAssistant
				? PHOTO_TURN_CAP
				: HISTORY_TURN_CAP;
		return `- ${recencyTag}${timePart} ${role}: ${sanitizeInput(turn.content, cap)}`;
	});
}
