/**
 * Telegram gateway types.
 *
 * Defines the message context passed to app handlers and the
 * TelegramService interface apps use to send messages.
 */

// ---------------------------------------------------------------------------
// Route metadata — how a message reached its app handler
// ---------------------------------------------------------------------------

/**
 * How the router decided which app to dispatch to.
 * - 'command'           — /command exact match
 * - 'intent'            — IntentClassifier LLM match (may have been verified)
 * - 'photo-intent'      — PhotoClassifier match or single-app photo shortcut
 * - 'context-promotion' — low-confidence result rescued by interaction context + verifier
 * - 'user-override'     — user tapped a verification button (bootstrap callback path)
 * - 'fallback'          — nothing matched; routed to chatbot or FallbackHandler
 */
export type RouteSource =
	| 'command'
	| 'intent'
	| 'photo-intent'
	| 'context-promotion'
	| 'user-override'
	| 'fallback';

/**
 * Whether the route verifier ran, and what it concluded.
 * - 'not-run'      — verifier not invoked (command, single-app photo, fallback, disabled)
 * - 'skipped'      — classifier confidence was high enough to bypass the verifier
 * - 'agreed'       — verifier ran and confirmed the classifier's pick
 * - 'degraded'     — verifier LLM failed, returned unparseable JSON, hallucinated an appId,
 *                    or button delivery failed — non-strict mode routed anyway
 * - 'user-override'— user resolved a held verification via inline button callback
 */
export type RouteVerifierStatus = 'not-run' | 'skipped' | 'agreed' | 'degraded' | 'user-override';

/**
 * Route metadata attached to handler contexts by the router.
 * Optional — present whenever the core router dispatched the message (always for
 * normal text/photo flows). Absent only for test fixtures that construct contexts
 * directly without going through the router.
 *
 * App handlers MUST treat this as advisory. Existing regex/keyword predicates
 * continue to function as the primary routing mechanism until LLM plan item #2
 * (Food structured classifier) is implemented.
 */
export interface RouteInfo {
	/** The app that was selected to handle this message. */
	appId: string;
	/**
	 * The intent identifier (classifier category, photoType, command name, or 'chatbot'
	 * for fallback). For commands, this is the command name (e.g. 'help', 'start').
	 */
	intent: string;
	/** Classifier confidence in [0, 1]. 1.0 for commands, single-app photo shortcut, user-override. */
	confidence: number;
	/** How the router determined the destination. */
	source: RouteSource;
	/** Whether the route verifier ran and what it concluded. */
	verifierStatus: RouteVerifierStatus;
}

// ---------------------------------------------------------------------------
// Handler context types
// ---------------------------------------------------------------------------

/** Context for an inbound text message routed to an app. */
export interface MessageContext {
	/** Telegram user ID of the sender. */
	userId: string;
	/** The text content of the message. */
	text: string;
	/** When the message was sent. */
	timestamp: Date;
	/** Telegram chat ID (for reply targeting). */
	chatId: number;
	/** Telegram message ID (for reply targeting). */
	messageId: number;
	/** Active space ID (set by router when user is in space mode). */
	spaceId?: string;
	/** Active space display name (for labels in responses). */
	spaceName?: string;
	/** Route metadata populated by the core router. Absent in direct-constructed test contexts. */
	route?: RouteInfo;
}

/** Context for an inbound photo message routed to an app. */
export interface PhotoContext {
	/** Telegram user ID of the sender. */
	userId: string;
	/** The photo data. */
	photo: Buffer;
	/** Optional caption attached to the photo. */
	caption?: string;
	/** MIME type of the photo (e.g. image/jpeg). */
	mimeType: string;
	/** When the message was sent. */
	timestamp: Date;
	/** Telegram chat ID. */
	chatId: number;
	/** Telegram message ID. */
	messageId: number;
	/** Route metadata populated by the core router. Absent in direct-constructed test contexts. */
	route?: RouteInfo;
}

/** Button for custom inline keyboards. */
export interface InlineButton {
	text: string;
	callbackData: string; // max 64 bytes (Telegram limit)
}

/** Identifies a sent message for later editing. */
export interface SentMessage {
	chatId: number;
	messageId: number;
}

/** Context passed to app callback handlers. */
export interface CallbackContext {
	userId: string;
	chatId: number;
	messageId: number; // the message the button was on
}

/** Telegram sending interface provided to apps via CoreServices. */
export interface TelegramService {
	/** Send a text message to a user. Supports Telegram Markdown. */
	send(userId: string, message: string): Promise<void>;

	/** Send a photo with an optional caption. */
	sendPhoto(userId: string, photo: Buffer, caption?: string): Promise<void>;

	/**
	 * Present a list of options as inline keyboard buttons.
	 * Returns the text of the selected option.
	 */
	sendOptions(userId: string, prompt: string, options: string[]): Promise<string>;

	/** Send a message with a custom inline keyboard. Returns message IDs for later editing. */
	sendWithButtons(userId: string, text: string, buttons: InlineButton[][]): Promise<SentMessage>;

	/** Edit an existing message's text and optionally its keyboard. Silently handles "not modified" errors. */
	editMessage(
		chatId: number,
		messageId: number,
		text: string,
		buttons?: InlineButton[][],
	): Promise<void>;
}
