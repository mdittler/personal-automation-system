import { describe, expect, it } from 'vitest';
import { escapeMarkdown } from '../escape-markdown.js';

describe('escapeMarkdown', () => {
	it('escapes asterisks', () => {
		expect(escapeMarkdown('hello *world*')).toBe('hello \\*world\\*');
	});

	it('escapes underscores', () => {
		expect(escapeMarkdown('hello _world_')).toBe('hello \\_world\\_');
	});

	it('escapes backticks', () => {
		expect(escapeMarkdown('hello `world`')).toBe('hello \\`world\\`');
	});

	it('escapes square brackets', () => {
		expect(escapeMarkdown('hello [world]')).toBe('hello \\[world\\]');
	});

	it('escapes parentheses', () => {
		expect(escapeMarkdown('hello (world)')).toBe('hello \\(world\\)');
	});

	it('escapes multiple special characters in one string', () => {
		expect(escapeMarkdown('*bold* and _italic_ and `code`')).toBe(
			'\\*bold\\* and \\_italic\\_ and \\`code\\`',
		);
	});

	it('passes safe strings through unchanged', () => {
		expect(escapeMarkdown('hello world 123')).toBe('hello world 123');
	});

	it('handles empty string', () => {
		expect(escapeMarkdown('')).toBe('');
	});

	it('does not escape MarkdownV2-only characters', () => {
		expect(escapeMarkdown('hello.world! test-case #1 ~strikethrough~')).toBe(
			'hello.world! test-case #1 ~strikethrough~',
		);
	});
});
