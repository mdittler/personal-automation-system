/**
 * Conversation-history framing helpers.
 * Last 4 turns get [Recent]; earlier turns get [Earlier]. Kept bit-for-bit
 * identical to pre-P0 chatbot behavior (apps/chatbot/src/index.ts:533).
 */
import { formatRelativeTime } from '../../utils/cron-describe.js';
import type { ConversationTurn } from '../conversation-history/index.js';
import { sanitizeInput } from './sanitization.js';

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
		return `- ${recencyTag}${timePart} ${role}: ${sanitizeInput(turn.content, 500)}`;
	});
}
