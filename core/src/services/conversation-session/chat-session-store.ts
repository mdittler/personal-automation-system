export interface ChatSessionFrontmatter {
	id: string;
	source: 'telegram' | 'legacy-import';
	user_id: string;
	household_id: string | null;
	model: string | null;
	title: string | null;
	parent_session_id: string | null;
	started_at: string;
	ended_at: string | null;
	token_counts: { input: number; output: number };
}

export interface SessionTurn {
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
	tokens?: { input?: number; output?: number };
}

export interface ChatSessionStore {
	peekActive(ctx: { userId: string; sessionKey: string }): Promise<string | undefined>;
	appendExchange(
		ctx: {
			userId: string;
			sessionKey: string;
			model?: string;
			householdId?: string | null;
			expectedSessionId?: string;
		},
		userTurn: SessionTurn,
		assistantTurn: SessionTurn,
	): Promise<{ sessionId: string }>;
	loadRecentTurns(
		ctx: { userId: string; sessionKey: string },
		opts?: { maxTurns?: number },
	): Promise<SessionTurn[]>;
	endActive(
		ctx: { userId: string; sessionKey: string },
		reason: 'newchat' | 'reset' | 'system',
	): Promise<{ endedSessionId: string | null }>;
	readSession(
		userId: string,
		sessionId: string,
	): Promise<{ meta: ChatSessionFrontmatter; turns: SessionTurn[] } | undefined>;
}
