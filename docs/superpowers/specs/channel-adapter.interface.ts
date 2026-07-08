/**
 * SR-2 — ChannelAdapter seam: interface PROPOSAL (declarations only).
 *
 * STATUS: This file is a design artifact accompanying
 * `2026-07-08-sr-2-channel-adapter-seam.md`. It is NOT compiled into core
 * (core's tsconfig includes `core/src/**` only; nothing imports this file).
 * It is written to typecheck standalone under `tsc --strict` with no
 * dependencies — `Uint8Array` is a PROPOSAL CONVENIENCE standing in for
 * Node's `Buffer` (which extends it) so no `@types/node` import is needed.
 * The real implementation keeps today's `Buffer` verbatim on the legacy
 * compat methods (byte-identical) and MAY widen to `Uint8Array` only on the
 * new neutral surface — do not read `Uint8Array` here as "the exact legacy
 * type." Biome checks this file on push (docs/ is not in the biome ignore
 * list); keep it lint- and format-clean.
 *
 * Layering (design doc §2): apps call MessengerService (northbound,
 * ergonomic, implemented once in core); channels implement ChannelAdapter
 * (southbound, minimal). The InteractionBroker and ChannelSendPolicy are
 * core-generic; TelegramSendPolicy is the first policy implementation.
 *
 * Implementation bodies, wiring, and the Telegram adapter itself belong to
 * the SR-2 implementing phase. Do not import this file from core/src.
 */

// ---------------------------------------------------------------------------
// Identity primitives
// ---------------------------------------------------------------------------

/** Channel identifier, e.g. 'telegram'. Closed set per deployment. */
export type ChannelId = string;

/**
 * The channel's own addressee handle (branded to prevent silent mixing with
 * PAS user ids). Telegram: the stringified numeric user id — which is also
 * the PAS user id today, so SR-2's resolveDelivery is the identity function.
 */
export type NativeRecipientId = string & { readonly __brand: 'NativeRecipientId' };

/**
 * Opaque reference to a sent message, used for later edits.
 * Telegram native shape: `{ chatId: number; messageId: number }`
 * (today's `SentMessage`). `native` is `unknown` on purpose — consumers
 * narrow through a per-channel guard; apps never read it directly.
 */
export interface ChannelMessageRef {
	readonly channelId: ChannelId;
	readonly native: unknown;
}

/** Correlation token for an ephemeral prompt, minted by the InteractionBroker. */
export type InteractionToken = string & { readonly __brand: 'InteractionToken' };

// ---------------------------------------------------------------------------
// Capability descriptor (design doc §4) — STATIC per channel in SR-2.
// Fields are facts about the channel, not SR-1 permission capabilities.
// ---------------------------------------------------------------------------

/**
 * Markup dialect the channel renders. The AUTHORING dialect is frozen as
 * 'telegram-markdown' (PAS message markup, design doc §8); each channel's
 * send policy translates authoring markup to its native dialect
 * (identity for Telegram).
 */
export type MarkupDialect = 'telegram-markdown' | 'plain';

/**
 * How the channel supports the ephemeral await-a-choice interaction (§7):
 * - 'native-buttons'  — inline keyboard or equivalent (Telegram)
 * - 'numbered-reply'  — core renders a numbered list; next matching reply answers
 * - 'none'            — one-way channel; promptChoice rejects immediately
 */
export type InteractionMode = 'native-buttons' | 'numbered-reply' | 'none';

export interface ChannelDescriptor {
	readonly id: ChannelId;
	/** Native rendering dialect the send policy targets. Telegram: 'telegram-markdown'. */
	readonly markup: MarkupDialect;
	/**
	 * Enforced outbound text budget per message. Telegram: 4000 (hard cap 4096,
	 * headroom for Markdown escapes / trailing whitespace — reply-buffer.ts).
	 */
	readonly maxMessageLength: number;
	/** Ephemeral prompt support mode. Telegram: 'native-buttons'. */
	readonly interaction: InteractionMode;
	/**
	 * PERSISTENT app-owned interactive messages (sendButtons). Distinct from
	 * `interaction`: prompts degrade automatically, persistent buttons do NOT —
	 * apps consult this flag; violating it raises ChannelCapabilityError (§7).
	 */
	readonly supportsButtons: boolean;
	/**
	 * Max bytes of the FINAL ENCODED callback payload per button — measured
	 * AFTER core stamps its namespace prefix (`app:<appId>:` etc., §9) or the
	 * broker encodes its token, NOT on the app's raw data. Telegram: 64.
	 * Validation is applied by core at the encoded boundary; an app's usable
	 * budget is 64 minus the core overhead for that button's namespace.
	 */
	readonly buttonDataLimitBytes?: number;
	/** Photo/media send support. Telegram: true. */
	readonly supportsPhoto: boolean;
	/** In-place message editing support. Telegram: true. */
	readonly supportsEdit: boolean;
}

// ---------------------------------------------------------------------------
// Outbound payloads (design doc §3)
// ---------------------------------------------------------------------------

/**
 * Text plus an explicit markup application flag. Preserves today's per-call
 * asymmetry: plain sends / button texts / edits render authored markup
 * (parse_mode Markdown), photo captions and option prompts render plain.
 */
export interface OutboundText {
	readonly text: string;
	readonly markup: 'authored' | 'plain';
}

/**
 * One button of a persistent app-owned keyboard.
 *
 * `data` is the APP'S RAW PORTION only — core stamps the owning namespace
 * prefix (`app:<appId>:`) when an app-scoped MessengerService sends the
 * button (§9), so neutral apps never write Telegram prefixes. The
 * descriptor.buttonDataLimitBytes budget is checked on the FINAL ENCODED
 * bytes (prefix + data), not on `data` alone. NOTE: the Stage-0 legacy
 * `sendWithButtons` passes `InlineButton.callbackData` through VERBATIM
 * (apps still write the full `app:<appId>:...` string) for byte-identical
 * behavior; prefix-stamping is a Stage-1 property of the neutral surface.
 */
export interface ButtonSpec {
	readonly label: string;
	/** App-defined raw callback data (core prepends the namespace prefix). */
	readonly data: string;
}

/** One choice of an ephemeral broker-owned prompt. */
export interface PromptChoice {
	/** Stable id echoed back in the choice event (Telegram encodes the index). */
	readonly id: string;
	readonly label: string;
}

/**
 * The rich-send family — exactly the sends the buffering proxy flushes for.
 * Adapters implement one exhaustive switch; unsupported kinds (per the
 * descriptor) raise ChannelCapabilityError rather than degrading silently.
 */
export type RichPayload =
	| {
			readonly kind: 'photo';
			/** Buffer at runtime (Buffer extends Uint8Array). Caption renders plain. */
			readonly data: Uint8Array;
			readonly caption?: string;
	  }
	| {
			readonly kind: 'buttons';
			readonly text: OutboundText;
			readonly buttons: ReadonlyArray<ReadonlyArray<ButtonSpec>>;
	  }
	| {
			readonly kind: 'prompt';
			/** Renders plain (today's sendOptions contract). One choice per row. */
			readonly text: string;
			readonly choices: ReadonlyArray<PromptChoice>;
			/** Minted by the InteractionBroker; encoded into native callback data. */
			readonly token: InteractionToken;
	  };

/** Patch for `edit`. Adapter maps native "nothing changed" to success. */
export interface EditPatch {
	readonly text: OutboundText;
	readonly buttons?: ReadonlyArray<ReadonlyArray<ButtonSpec>>;
}

// ---------------------------------------------------------------------------
// Inbound envelope (design doc §5)
// ---------------------------------------------------------------------------

/**
 * A native ack handle for a button tap. Telegram: the callback_query id used
 * by `answerCallbackQuery`. Opaque to core; passed back to
 * `ChannelAdapter.acknowledgeCallback` so the ack path never leaks through
 * `channel.native`.
 */
export type CallbackAckId = string & { readonly __brand: 'CallbackAckId' };

export type InboundContent =
	| { readonly kind: 'text'; readonly text: string }
	| {
			readonly kind: 'photo';
			readonly data: Uint8Array;
			readonly caption?: string;
			/** Telegram always converts photos to JPEG; other channels vary. */
			readonly mimeType: string;
	  }
	| {
			/**
			 * A NORMALIZED button/component tap. The adapter does NOT interpret
			 * PAS namespaces — it emits the raw callback payload verbatim and core's
			 * CallbackNamespaceRouter classifies it (`rv:` / `onboard:` / `sc:` /
			 * `app:` / `opt:`, precedence order — §5). A Discord adapter emits the
			 * same shape from a component interaction. `ackId` acknowledges the tap.
			 */
			readonly kind: 'button-callback';
			readonly rawData: string;
			readonly ackId: CallbackAckId;
	  };

/**
 * Channel-neutral inbound message — what the adapter can honestly produce.
 * Router-stamped metadata (route, sessionKey, spaceId, ...) is enrichment
 * applied AFTER this envelope, not part of it.
 */
export interface InboundMessage {
	/**
	 * The escape hatch. Telegram native shape:
	 * `{ chatId: number; messageId: number; callbackQueryId?: string }`.
	 * For core plumbing and the compat alias only — apps reading `native`
	 * is a migration smell the T6b gate flags.
	 */
	readonly channel: { readonly id: ChannelId; readonly native: unknown };
	/** PAS user id (post identity-resolution; equals the native id today). */
	readonly userId: string;
	/** Neutral conversation key. Telegram: String(chatId). */
	readonly conversationId: string;
	readonly messageRef: ChannelMessageRef;
	readonly timestamp: Date;
	readonly content: InboundContent;
}

/** Core-side sink the adapter delivers inbound envelopes to. */
export interface ChannelInboundSink {
	deliver(message: InboundMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// The southbound seam: what a channel implements (design doc §3)
// ---------------------------------------------------------------------------

/**
 * Raised when a caller asks a channel for something its descriptor declares
 * unsupported (e.g. persistent buttons on a no-buttons channel). Fail-loud;
 * never a silent degrade.
 */
export interface ChannelCapabilityError extends Error {
	readonly name: 'ChannelCapabilityError';
	readonly channelId: ChannelId;
	/** The descriptor field that was violated, e.g. 'supportsButtons'. */
	readonly capability: string;
}

export interface ChannelAdapter {
	readonly descriptor: ChannelDescriptor;

	/**
	 * Deliver pre-rendered text already within descriptor.maxMessageLength.
	 * Splitting/packing is the generic layer's job (via ChannelSendPolicy),
	 * never the adapter's.
	 */
	send(recipient: NativeRecipientId, text: OutboundText): Promise<void>;

	/**
	 * Deliver one rich payload. Returns a ref usable with `edit`.
	 * Must be preceded by any pending plain-text flush (proxy's job).
	 */
	sendRich(recipient: NativeRecipientId, payload: RichPayload): Promise<ChannelMessageRef>;

	/**
	 * Edit a previously sent message. Contract obligations:
	 * - map the channel's "nothing changed" rejection to success
	 *   (Telegram's "message is not modified" swallow);
	 * - order-independent — never routed through any send buffer.
	 */
	edit(ref: ChannelMessageRef, patch: EditPatch): Promise<void>;

	/**
	 * Acknowledge a button/component tap (Telegram: `answerCallbackQuery`).
	 * Core calls this exactly once per `button-callback` event — with optional
	 * toast `text` when a handler supplies one, else a bare ack — mirroring
	 * today's auto-ack-in-`finally` unless a handler already answered
	 * (compose-runtime.ts:1605). A channel with no ack concept implements a
	 * no-op. Best-effort: failures are swallowed (today's `.catch(() => {})`).
	 */
	acknowledgeCallback(ackId: CallbackAckId, opts?: { readonly text?: string }): Promise<void>;

	/** Begin converting native updates into InboundMessage deliveries. */
	start(sink: ChannelInboundSink): Promise<void>;

	/** Stop inbound delivery and release transport resources. */
	stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Core-owned callback namespace routing (design doc §5) — the Critical fix
// ---------------------------------------------------------------------------

/**
 * Result of classifying a normalized `button-callback`'s `rawData`. Core owns
 * the registry; the adapter stays namespace-agnostic. Precedence order is
 * fixed and total (first matching prefix wins; unknown → 'unhandled'):
 *   1. 'route-verify'  — `rv:` (route-verifier.ts:301)
 *   2. 'onboarding'    — `onboard:` (first-run-wizard.ts:113)
 *   3. 'session-ctrl'  — `sc:yes|sc:no` (router/index.ts:1892)
 *   4. 'app'           — `app:<appId>:<data>` (compose-runtime.ts:1566)
 *   5. 'prompt'        — `opt:<nonce>:<i>` (InteractionBroker; telegram/index.ts:70)
 * The `app` case carries the parsed appId + the app-portion data; the
 * `prompt` case carries the broker token + choice id. Every other namespace
 * is a core-internal handler keyed by the raw payload.
 */
export type CallbackClassification =
	| { readonly namespace: 'route-verify'; readonly rawData: string }
	| { readonly namespace: 'onboarding'; readonly rawData: string }
	| { readonly namespace: 'session-ctrl'; readonly rawData: string }
	| { readonly namespace: 'app'; readonly appId: string; readonly data: string }
	| { readonly namespace: 'prompt'; readonly token: InteractionToken; readonly choiceId: string }
	| { readonly namespace: 'unhandled'; readonly rawData: string };

/**
 * Core-side classifier for normalized button callbacks. Registered handlers
 * (route-verifier, onboarding, session-control, app dispatch, the
 * InteractionBroker) consume the classification; this is where PAS callback
 * semantics live, NOT in any adapter. New core namespaces register here — a
 * new channel needs zero changes to gain them.
 */
export interface CallbackNamespaceRouter {
	classify(rawData: string): CallbackClassification;
}

// ---------------------------------------------------------------------------
// Channel send policy (design doc §6): the proxy owns WHEN, the policy owns HOW
// ---------------------------------------------------------------------------

/**
 * Per-channel rendering rules consumed by the channel-GENERIC
 * BufferingMessengerProxy and MessengerCore. TelegramSendPolicy composes the
 * existing pure functions unchanged: packSegments (@4000), the
 * paragraph→line→hard split of splitTelegramMessage (@3800 — both budgets
 * carried as-is for byte-identical behavior), escapeMarkdown, stripMarkdown.
 */
export interface ChannelSendPolicy {
	readonly descriptor: ChannelDescriptor;
	/** Joiner between buffered segments. Telegram: '\n\n'. */
	readonly segmentSeparator: string;
	/** Pack ordered segments into messages within the outbound budget. */
	pack(segments: ReadonlyArray<string>): string[];
	/** Split one long text into channel-safe chunks (conversation path). */
	split(text: string): string[];
	/** Escape interpolated data against the authoring dialect (escapeMarkdown). */
	escapeInterpolated(text: string): string;
	/** Strip markup for the parse-failure retry fallback (stripMarkdown). */
	degradeMarkup(text: string): string;
}

// ---------------------------------------------------------------------------
// Interaction broker (design doc §7): channel-generic await-a-choice state
// ---------------------------------------------------------------------------

/**
 * Full scope a prompt is keyed by — `channelId + conversationId + userId`
 * plus the minted token. Keying on userId alone (as the first draft did) lets
 * a reply from the SAME user in a DIFFERENT conversation/channel satisfy the
 * wrong prompt once channels or group/workspace conversations exist. All four
 * fields must match for a resolution to bind.
 */
export interface PromptScope {
	readonly channelId: ChannelId;
	readonly conversationId: string;
	readonly userId: string;
}

/**
 * Owns the correlation state formerly inside TelegramServiceImpl's pending
 * map: token mint, single-shot resolve, timeout (default 5 min), and
 * scope-match verification. Renders via the adapter per
 * descriptor.interaction: 'native-buttons' → prompt payload; 'numbered-reply'
 * → generic numbered list + transient reply-interceptor scoped to the same
 * PromptScope; 'none' → immediate ChannelCapabilityError rejection.
 */
export interface InteractionBroker {
	/**
	 * Ask the user to pick one choice; resolves with the picked choice. The
	 * scope (channel + conversation + user) is captured so answers can only
	 * resolve within the same conversation the prompt was posed in.
	 */
	promptChoice(
		scope: PromptScope,
		prompt: string,
		choices: ReadonlyArray<PromptChoice>,
		opts?: { readonly timeoutMs?: number },
	): Promise<PromptChoice>;

	/**
	 * Inbound path: resolve a parked prompt from a delivered message. The
	 * broker checks the full scope (channelId + conversationId + userId) AND
	 * the token AND the choice id. Returns false for unknown/expired tokens,
	 * scope mismatch (wrong conversation OR wrong user), or invalid choice ids
	 * (log-and-ignore, never throw — today's callback tolerance, preserved).
	 * Called for 'prompt'-namespace button callbacks and for numbered-reply
	 * text matches.
	 */
	resolveChoice(inbound: InboundMessage, token: InteractionToken, choiceId: string): boolean;

	/** Reject all parked prompts (shutdown path). */
	cleanup(): void;
}

// ---------------------------------------------------------------------------
// Northbound app-facing surface (design doc §9) — what CoreServices injects
// ---------------------------------------------------------------------------

/**
 * Legacy inline-keyboard button — the EXACT current shape
 * (`core/src/types/telegram.ts:131`). Reproduced so the Stage-0 compat
 * methods below carry today's signatures verbatim. `callbackData` is passed
 * through UNCHANGED (apps still write the full `app:<appId>:...` string).
 */
export interface InlineButton {
	readonly text: string;
	/** Max 64 bytes (Telegram limit), measured on this final encoded string. */
	readonly callbackData: string;
}

/**
 * Legacy sent-message id — the EXACT current shape (`telegram.ts:137`).
 * The neutral `ChannelMessageRef` supersedes it; kept for the compat method.
 */
export interface SentMessage {
	readonly chatId: number;
	readonly messageId: number;
}

/**
 * The ergonomic surface apps program against, implemented ONCE in core over
 * any ChannelAdapter.
 *
 * APP-SCOPED: core injects a PER-APP instance (bound to the app's id) into
 * `CoreServices.messenger`/`.telegram`, so the neutral `sendButtons` stamps
 * the owning `app:<appId>:` namespace onto each button's callback data
 * automatically — neutral apps never write Telegram prefixes, and the adapter
 * can still route the inbound `app`-namespace callback to the right app (§5).
 *
 * Stage 0 = today's TelegramService contract VERBATIM (byte-identical incl.
 * legacy `sendWithButtons`/`editMessage`); Stage 1 = the neutral additions
 * apps migrate to per T5 slice. During migration `TelegramService` = alias of
 * this interface, and CoreServices exposes the SAME instance under both
 * `telegram` and `messenger` keys.
 */
export interface MessengerService {
	// --- Stage 0 compat surface (EXACT legacy signatures; byte-identical) ---
	/** Send a text message. Authored markup (Telegram parse_mode Markdown). */
	send(userId: string, message: string): Promise<void>;
	/**
	 * Send a photo with an optional (plain-rendered) caption. Legacy shape
	 * uses Node `Buffer` at runtime (`Uint8Array` here is the proposal
	 * convenience noted in the file header).
	 */
	sendPhoto(userId: string, photo: Uint8Array, caption?: string): Promise<void>;
	/** Ephemeral await-a-choice; resolves with the selected option's text. */
	sendOptions(userId: string, prompt: string, options: string[]): Promise<string>;
	/**
	 * LEGACY (compat): persistent inline keyboard, callbackData passed through
	 * verbatim, returns legacy `SentMessage`. Exact shape of
	 * `TelegramService.sendWithButtons` (`telegram.ts:164`). Deprecated in
	 * favor of `sendButtons`; kept so Stage-0 apps/tests are untouched.
	 * @deprecated migrate to `sendButtons` (returns `ChannelMessageRef`).
	 */
	sendWithButtons(userId: string, text: string, buttons: InlineButton[][]): Promise<SentMessage>;
	/**
	 * LEGACY (compat): edit by native chatId/messageId. Exact shape of
	 * `TelegramService.editMessage` (`telegram.ts:167`). Silently swallows the
	 * "not modified" error.
	 * @deprecated migrate to `edit(ref, ...)`.
	 */
	editMessage(
		chatId: number,
		messageId: number,
		text: string,
		buttons?: InlineButton[][],
	): Promise<void>;

	// --- Neutral surface (Stage 1 targets) ---
	/**
	 * Persistent app-owned keyboard. Requires descriptor.supportsButtons.
	 * Core stamps `app:<appId>:` onto each ButtonSpec.data (this instance is
	 * app-scoped); the 64-byte budget is checked on the stamped result.
	 */
	sendButtons(
		userId: string,
		text: string,
		buttons: ReadonlyArray<ReadonlyArray<ButtonSpec>>,
	): Promise<ChannelMessageRef>;
	/** Edit a previously sent message via its neutral ref. */
	edit(
		ref: ChannelMessageRef,
		text: string,
		buttons?: ReadonlyArray<ReadonlyArray<ButtonSpec>>,
	): Promise<void>;
}

// ---------------------------------------------------------------------------
// Delivery resolution (design doc §3) — the single userId→channel home
// ---------------------------------------------------------------------------

/**
 * Resolves a PAS user to a deliverable channel target. SR-2: identity onto
 * the sole Telegram adapter. Multi-channel bindings are deferred (design
 * doc §12 Q2) but this is their one future home.
 */
export interface DeliveryResolver {
	resolveDelivery(userId: string): { adapter: ChannelAdapter; recipient: NativeRecipientId };
}
