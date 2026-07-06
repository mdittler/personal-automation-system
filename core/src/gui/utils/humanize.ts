/** Single source for system-string → plain-language labels (audit M3). */
const LABELS: Record<string, string> = {
	deterministic: 'Exact rule',
	fuzzy: 'AI judgment',
	telegram_message: 'Send a Telegram message',
	run_report: 'Run a report',
	webhook: 'Call a webhook',
	write_data: 'Write to a data file',
	audio: 'Play a sound',
	dispatch_message: 'Send a message as the user',
	scheduled: 'On a schedule',
	event: 'When something happens',
	changes: 'Recent changes',
	'app-data': 'App data',
	context: 'Saved context',
	custom: 'Custom text',
};

export function humanizeLabel(value: string): string {
	if (!value) return '';
	const known = LABELS[value];
	if (known) return known;
	const words = value.replace(/[_-]+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}
