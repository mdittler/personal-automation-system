/**
 * Telegram gateway types.
 *
 * Defines the message context passed to app handlers and the
 * TelegramService interface apps use to send messages.
 */

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
