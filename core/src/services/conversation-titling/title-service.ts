import type { ChatSessionStore } from '../conversation-session/index.js';
import type { ChatTranscriptIndex } from '../chat-transcript-index/chat-transcript-index.js';

export interface TitleServiceDeps {
	chatSessions: ChatSessionStore;
	chatTranscriptIndex: ChatTranscriptIndex;
	// Narrow logger shape — matches recall-classifier.ts. AppLogger import
	// (`../../types/app-module.js`) is available if a wider type is ever needed.
	logger: { warn(obj: unknown, msg?: string): void };
}

export interface ApplyTitleResult {
	/** True if the markdown frontmatter was rewritten with the new title. */
	updated: boolean;
	/** The sanitized title that was written, when updated === true. */
	title?: string;
}

/**
 * Best-effort sequential application: write Markdown frontmatter first (canonical),
 * then update the SQLite index (derived). The two steps are NOT atomic; an index
 * failure is logged but does not roll back the Markdown write. If the index drifts,
 * `pnpm chat-index-rebuild` is the recovery tool.
 */
export class TitleService {
	constructor(private readonly deps: TitleServiceDeps) {}

	async applyTitle(
		userId: string,
		sessionId: string,
		title: string,
		opts?: { skipIfTitled?: boolean },
	): Promise<ApplyTitleResult> {
		let setResult: { updated: boolean };
		try {
			setResult = await this.deps.chatSessions.setTitle(userId, sessionId, title, opts);
		} catch (err) {
			this.deps.logger.warn({ err, userId, sessionId }, 'title-service: setTitle failed');
			return { updated: false };
		}
		if (!setResult.updated) return { updated: false };

		try {
			const idxResult = await this.deps.chatTranscriptIndex.updateTitle(userId, sessionId, title);
			if (!idxResult.updated) {
				this.deps.logger.warn(
					{ userId, sessionId },
					'title-service: chat-transcript-index updateTitle returned updated:false',
				);
			}
		} catch (err) {
			this.deps.logger.warn({ err, userId, sessionId }, 'title-service: chat-transcript-index updateTitle failed');
		}

		return { updated: true, title };
	}
}
