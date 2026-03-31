/**
 * Conversation history manager.
 *
 * Stores per-user conversation turns as JSON via ScopedDataStore.
 * Maintains a sliding window of recent turns for LLM context.
 */

import type { ScopedDataStore } from '@pas/core/types';

const HISTORY_FILE = 'history.json';

/** A single conversation turn (user or assistant). */
export interface ConversationTurn {
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
}

export interface ConversationHistoryOptions {
	/** Maximum number of turns to retain. Default: 20 (10 exchanges). */
	maxTurns?: number;
}

export class ConversationHistory {
	private readonly maxTurns: number;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(options?: ConversationHistoryOptions) {
		this.maxTurns = Math.max(1, options?.maxTurns ?? 20);
	}

	/** Load conversation history from the user's scoped store. */
	async load(store: ScopedDataStore): Promise<ConversationTurn[]> {
		const raw = await store.read(HISTORY_FILE);
		if (!raw) return [];

		try {
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.slice(-this.maxTurns);
		} catch {
			return [];
		}
	}

	/**
	 * Append user and assistant turns, then save.
	 * Truncates to maxTurns, keeping the most recent.
	 * Serialized via writeQueue to prevent concurrent read-modify-write races.
	 */
	async append(
		store: ScopedDataStore,
		userTurn: ConversationTurn,
		assistantTurn: ConversationTurn,
	): Promise<void> {
		const task = this.writeQueue.then(
			() => this.doAppend(store, userTurn, assistantTurn),
			() => this.doAppend(store, userTurn, assistantTurn),
		);
		this.writeQueue = task.catch(() => {});
		return task;
	}

	private async doAppend(
		store: ScopedDataStore,
		userTurn: ConversationTurn,
		assistantTurn: ConversationTurn,
	): Promise<void> {
		const history = await this.load(store);
		history.push(userTurn, assistantTurn);
		const trimmed = history.slice(-this.maxTurns);
		await store.write(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
	}
}
