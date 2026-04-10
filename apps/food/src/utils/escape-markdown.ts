/**
 * Escape user-controlled text for safe interpolation into Telegram messages
 * that use the legacy Markdown parse mode (the mode used by `services.telegram.send`
 * across the food app).
 *
 * Telegram legacy markdown treats `*`, `_`, `` ` ``, and `[` as control
 * characters. If a user-supplied label contains them, the message either
 * renders broken or the Telegram API rejects the send entirely with
 * "can't parse entities". We intentionally escape conservatively rather than
 * trying to permit partial markdown.
 */

const SPECIALS = /[*_`[\]()]/g;

export function escapeMarkdown(text: string): string {
	return text.replace(SPECIALS, (m) => '\\' + m);
}
