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

describe('escapeMarkdown — stored data regression (Gap 6)', () => {
	it('escapes markdown table row with bold cell', () => {
		expect(escapeMarkdown('| *Chicken* | 500g | $4.99 |')).toBe(
			'| \\*Chicken\\* | 500g | $4.99 |',
		);
	});

	it('escapes URL with parentheses', () => {
		expect(escapeMarkdown('[recipe](https://example.com/path_(1))')).toBe(
			'\\[recipe\\]\\(https://example.com/path\\_\\(1\\)\\)',
		);
	});

	it('escapes ingredient quantity with asterisks', () => {
		expect(escapeMarkdown('2* large eggs')).toBe('2\\* large eggs');
	});

	it('escapes inline code and bold in mixed report line', () => {
		expect(escapeMarkdown('`code` and *bold* and _italic_')).toBe(
			'\\`code\\` and \\*bold\\* and \\_italic\\_',
		);
	});

	it('escapes alert template with square brackets and underscores', () => {
		expect(escapeMarkdown('{alert_name} triggered [see log]')).toBe(
			'{alert\\_name} triggered \\[see log\\]',
		);
	});

	it('escapes YAML frontmatter title with special chars', () => {
		expect(escapeMarkdown('title: "Mom\'s _Special_ Recipe"')).toBe(
			'title: "Mom\'s \\_Special\\_ Recipe"',
		);
	});

	it('handles multiline string with mixed special characters', () => {
		const input = '*Bold heading*\n_italic note_\n`inline code`';
		expect(escapeMarkdown(input)).toBe(
			'\\*Bold heading\\*\n\\_italic note\\_\n\\`inline code\\`',
		);
	});

	it('does not alter plain grocery list text', () => {
		const input = '- Milk 2L\n- Bread\n- Eggs 12';
		expect(escapeMarkdown(input)).toBe(input);
	});
});
