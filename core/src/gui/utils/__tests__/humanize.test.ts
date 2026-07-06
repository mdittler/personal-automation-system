import { describe, expect, it } from 'vitest';
import { humanizeLabel } from '../humanize.js';

describe('humanizeLabel', () => {
	it('maps known system strings to plain language', () => {
		expect(humanizeLabel('deterministic')).toBe('Exact rule');
		expect(humanizeLabel('fuzzy')).toBe('AI judgment');
		expect(humanizeLabel('telegram_message')).toBe('Send a Telegram message');
		expect(humanizeLabel('run_report')).toBe('Run a report');
		expect(humanizeLabel('webhook')).toBe('Call a webhook');
		expect(humanizeLabel('write_data')).toBe('Write to a data file');
		expect(humanizeLabel('audio')).toBe('Play a sound');
		expect(humanizeLabel('dispatch_message')).toBe('Send a message as the user');
		expect(humanizeLabel('scheduled')).toBe('On a schedule');
		expect(humanizeLabel('event')).toBe('When something happens');
	});
	it('falls back to title-cased words for unknown snake_case values', () => {
		expect(humanizeLabel('some_unknown_value')).toBe('Some unknown value');
	});
	it('never returns an empty string', () => {
		expect(humanizeLabel('')).toBe('');
		expect(humanizeLabel('x')).toBe('X');
	});
});
