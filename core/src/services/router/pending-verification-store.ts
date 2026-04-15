import { randomBytes } from 'node:crypto';
import type { MessageContext, PhotoContext } from '../../types/telegram.js';

export interface PendingEntry {
	ctx: MessageContext | PhotoContext;
	isPhoto: boolean;
	classifierResult: { appId: string; intent: string; confidence: number };
	verifierSuggestedAppId: string;
	/** Intent the verifier suggested for the alternative app. Present when the verifier disagreed. */
	verifierSuggestedIntent?: string;
	sentMessageId: number;
	sentChatId: number;
	photoPath?: string;
	createdAt: Date;
}

export type PendingEntryInput = Omit<PendingEntry, 'createdAt'>;

export class PendingVerificationStore {
	private readonly entries = new Map<string, PendingEntry>();

	/** Store an entry and return its unique 12-char hex ID. */
	add(input: PendingEntryInput): string {
		const id = randomBytes(6).toString('hex');
		this.entries.set(id, { ...input, createdAt: new Date() });
		return id;
	}

	/** Retrieve an entry without removing it. */
	get(id: string): PendingEntry | undefined {
		return this.entries.get(id);
	}

	/** Remove and return an entry. Returns undefined if not found. */
	resolve(id: string): PendingEntry | undefined {
		const entry = this.entries.get(id);
		if (entry !== undefined) {
			this.entries.delete(id);
		}
		return entry;
	}

	/** Current number of pending entries. */
	get size(): number {
		return this.entries.size;
	}
}
