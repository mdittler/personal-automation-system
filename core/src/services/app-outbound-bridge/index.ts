import type { Logger } from 'pino';
import type { AppConfigService } from '../../types/config.js';
import type { InlineButton } from '../../types/telegram.js';
import type { ChatSessionStore, SessionTurn } from '../conversation-session/chat-session-store.js';
import { buildSessionKey } from '../conversation-session/session-key.js';
import type { HouseholdService } from '../household/index.js';
import { sanitizeAppMessageField } from './sanitize.js';

/** Max body length after sanitization. Sanitizer may add an ellipsis on truncation,
 * so worst-case output is 1900 chars — comfortably under PHOTO_TURN_CAP (2000). */
export const MAX_BODY_LEN = 1899;

const APP_ID_RE = /^[a-z0-9_-]{1,32}$/;
const KIND_RE = /^[a-z0-9_:-]{1,64}$/;
const MAX_BUTTON_LABEL_LEN = 50;

/**
 * Coerce arbitrary user-supplied names (report ids, alert names) into the
 * `KIND_RE` format. Used by callers that don't already produce slug-safe kinds.
 */
export function toAppMessageKind(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9:_-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/_+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
	return slug.length > 0 ? slug : 'untitled';
}

export interface RecordOutboundOpts {
	userId: string;
	appId: string;
	kind: string;
	body: string;
	buttons?: InlineButton[][];
}

export interface AppOutboundBridge {
	recordOutboundMessage(opts: RecordOutboundOpts): Promise<void>;
}

export interface AppOutboundBridgeDeps {
	chatSessions: ChatSessionStore;
	household?: HouseholdService;
	/** AppConfigServiceImpl scoped to the chatbot virtual app. */
	conversationConfig: AppConfigService;
	logger: Logger;
}

/**
 * Wraps {@link ChatSessionStore.appendExchange} with sanitization, opt-out
 * check, and fail-open semantics. Produces a synthetic user/assistant exchange
 * that records the outbound app message in the user's conversation transcript
 * so the chatbot can refer to it in later turns.
 */
export function createAppOutboundBridge(deps: AppOutboundBridgeDeps): AppOutboundBridge {
	return {
		async recordOutboundMessage(opts) {
			if (!APP_ID_RE.test(opts.appId) || !KIND_RE.test(opts.kind)) {
				deps.logger.warn(
					{ appId: opts.appId, kind: opts.kind },
					'AppOutboundBridge: rejecting malformed appId/kind',
				);
				return;
			}

			const overrides = await deps.conversationConfig.getAll(opts.userId);
			const enabled = overrides.app_message_bridge_enabled;
			if (enabled === false) return;

			const body = sanitizeAppMessageField(opts.body, MAX_BODY_LEN);
			if (body.length === 0) return;

			const buttonLabels =
				opts.buttons
					?.flat()
					.map((b) => sanitizeAppMessageField(b.text, MAX_BUTTON_LABEL_LEN))
					.filter((s) => s.length > 0) ?? [];
			const buttonFooter =
				buttonLabels.length > 0 ? `\n[Buttons: ${buttonLabels.join(' | ')}]` : '';

			const householdId = deps.household?.getHouseholdForUser(opts.userId) ?? undefined;
			const sessionKey = buildSessionKey({
				agent: 'main',
				channel: 'telegram',
				scope: 'dm',
				chatId: opts.userId,
			});

			try {
				const now = new Date().toISOString();
				// source: 'app' is added by Task 5a (which will extend SessionTurn).
				// Cast through unknown until that schema change lands, so the field
				// is already written and Task 5a doesn't have to touch this file.
				const userTurn = {
					role: 'user',
					content: `[App: ${opts.appId}] ${opts.kind}`,
					timestamp: now,
					source: 'app',
				} as unknown as SessionTurn;
				const assistantTurn = {
					role: 'assistant',
					content: body + buttonFooter,
					timestamp: now,
					source: 'app',
				} as unknown as SessionTurn;
				await deps.chatSessions.appendExchange(
					{ userId: opts.userId, sessionKey, householdId },
					userTurn,
					assistantTurn,
				);
			} catch (error) {
				deps.logger.warn(
					{ error, userId: opts.userId, appId: opts.appId, kind: opts.kind },
					'AppOutboundBridge: append failed (fail-open)',
				);
			}
		},
	};
}

/**
 * Late-bound proxy used to navigate `compose-runtime`'s construction order:
 * ReportService and AlertService are built before `chatSessions` and the
 * conversation `AppConfigServiceImpl` exist. Inject this proxy early, then
 * call {@link LateBoundAppOutboundBridge.bind} once the real impl can be
 * constructed.
 *
 * Calls before {@link LateBoundAppOutboundBridge.bind} are silently no-ops —
 * the bridge is fail-open by design.
 */
export class LateBoundAppOutboundBridge implements AppOutboundBridge {
	private impl: AppOutboundBridge | null = null;

	bind(impl: AppOutboundBridge): void {
		if (this.impl != null) {
			throw new Error('LateBoundAppOutboundBridge already bound');
		}
		this.impl = impl;
	}

	async recordOutboundMessage(opts: RecordOutboundOpts): Promise<void> {
		if (this.impl == null) return;
		await this.impl.recordOutboundMessage(opts);
	}
}
