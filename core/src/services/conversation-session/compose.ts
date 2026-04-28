import type { Logger } from 'pino';
import type { DataStoreService } from '../../types/data-store.js';
import { DefaultChatSessionStore } from './chat-session-store.js';
import type { ChatSessionStore } from './chat-session-store.js';

export interface ChatSessionStoreOptions {
	data: DataStoreService;
	logger: Logger;
	clock?: () => Date;
	rng?: () => string;
}

export function composeChatSessionStore(options: ChatSessionStoreOptions): ChatSessionStore {
	return new DefaultChatSessionStore(options);
}
