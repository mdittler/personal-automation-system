/**
 * Escape Telegram legacy Markdown control characters in user/stored data.
 *
 * TelegramService uses parse_mode: 'Markdown' (legacy), where *, _, `, and [
 * are control characters. This function escapes them so interpolated data
 * renders as literal text rather than triggering formatting or causing
 * "can't parse entities" API errors.
 */
const SPECIALS = /[*_`[\]()]/g;

export function escapeMarkdown(text: string): string {
	return text.replace(SPECIALS, (m) => '\\' + m);
}
