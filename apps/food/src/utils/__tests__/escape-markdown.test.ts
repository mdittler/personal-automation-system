/**
 * Regression tests for the Telegram-markdown escape utility.
 *
 * Added for finding H6: user-controlled labels containing `*` `_` `[` would
 * either break the bold-span rendering of `**${label}**` or trigger Telegram
 * "can't parse entities" errors that drop the message entirely.
 */

import { describe, it, expect } from 'vitest';
import { escapeMarkdown } from '../escape-markdown.js';

describe('escapeMarkdown', () => {
	it('escapes the special characters Telegram legacy markdown reserves', () => {
		expect(escapeMarkdown('a*b')).toBe('a\\*b');
		expect(escapeMarkdown('a_b')).toBe('a\\_b');
		expect(escapeMarkdown('a`b')).toBe('a\\`b');
		expect(escapeMarkdown('a[b]c')).toBe('a\\[b\\]c');
		expect(escapeMarkdown('a(b)c')).toBe('a\\(b\\)c');
	});

	it('leaves regular text alone', () => {
		expect(escapeMarkdown('Chipotle bowl')).toBe('Chipotle bowl');
		expect(escapeMarkdown('Pâté de campagne')).toBe('Pâté de campagne');
	});

	it('makes a label safe to embed in **${label}**', () => {
		const userLabel = '**injected** dinner';
		const escaped = escapeMarkdown(userLabel);
		// The bold span itself stays intact, but the inner asterisks are
		// escaped so Telegram does not interpret them.
		const rendered = `**${escaped}**`;
		expect(rendered).toBe('**\\*\\*injected\\*\\* dinner**');
	});
});
