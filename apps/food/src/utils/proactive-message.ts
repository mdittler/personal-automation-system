import type { CoreServices, InlineButton, SentMessage } from '@pas/core/types';

/**
 * Closed catalog of valid Food proactive `kind` values. All satisfy the
 * AppOutboundBridge `KIND_RE` (/^[a-z0-9_:-]{1,64}$/) and the fencing header
 * shared regex. Add new kinds here when a new proactive flow ships.
 */
export type FoodProactiveKind =
	| 'weekly-menu'
	| 'weekly-nutrition'
	| 'weekly-health'
	| 'batch-prep'
	| 'nightly-rating-prompt'
	| 'perishable-check'
	| 'leftover-check'
	| 'freezer-check'
	| 'defrost-reminder'
	| 'cuisine-diversity-nudge'
	| 'seasonal-nudge'
	| 'cultural-calendar';

export interface ProactiveMessageOpts {
	userId: string;
	kind: FoodProactiveKind;
	body: string;
	buttons?: InlineButton[][];
}

/**
 * The single path for Food proactive (app-initiated, non-reply) Telegram
 * sends. Pairs Telegram delivery with the AppOutboundBridge record so the
 * chatbot transcript captures the message and Gus can answer follow-ups.
 *
 * Semantics:
 *  - The bridge call is fail-open and happens only AFTER the Telegram send
 *    resolves. A bridge failure must never block, fail, or surface from an
 *    app send — it is logged at warn level and swallowed.
 *  - The raw `body` is passed to the bridge unchanged. Sanitization is the
 *    bridge's job, verified separately in integration tests.
 *  - Returns the `SentMessage` when buttons were sent (callers may need the
 *    `messageId` for callback resolution, e.g. batch-prep freeze flows);
 *    returns `undefined` for a plain text send.
 *
 * Do NOT use this helper for:
 *  - replies to user input (the inbound message path already handles those)
 *  - `editMessage` updates
 *  - photo results
 */
export async function sendProactiveMessage(
	services: CoreServices,
	opts: ProactiveMessageOpts,
): Promise<SentMessage | undefined> {
	let sent: SentMessage | undefined;
	if (opts.buttons && opts.buttons.length > 0) {
		sent = await services.telegram.sendWithButtons(opts.userId, opts.body, opts.buttons);
	} else {
		await services.telegram.send(opts.userId, opts.body);
	}

	try {
		await services.appOutboundBridge?.recordOutboundMessage({
			userId: opts.userId,
			appId: 'food',
			kind: opts.kind,
			body: opts.body,
			buttons: opts.buttons,
		});
	} catch (err) {
		services.logger?.warn(
			{ err, userId: opts.userId, kind: opts.kind },
			'sendProactiveMessage: bridge record failed (fail-open)',
		);
	}

	return sent;
}
