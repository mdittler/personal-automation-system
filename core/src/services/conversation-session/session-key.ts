import { InvalidSessionKeyError } from './errors.js';

export interface SessionKeyParts {
	agent: 'main';
	channel: 'telegram';
	scope: 'dm' | 'group';
	chatId: string;
}

// Reject colon (key delimiter), double-dot (traversal), path separators, empty string
const FORBIDDEN = /[:/\\]|^\s*$|\.{2}/;

export function buildSessionKey({ agent, channel, scope, chatId }: SessionKeyParts): string {
	if (FORBIDDEN.test(chatId)) {
		throw new InvalidSessionKeyError(`chatId rejected: ${JSON.stringify(chatId)}`);
	}
	return `agent:${agent}:${channel}:${scope}:${chatId}`;
}
