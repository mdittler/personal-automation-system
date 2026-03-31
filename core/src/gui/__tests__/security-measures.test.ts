/**
 * Security measure tests.
 *
 * Tests the security patterns used across GUI routes and the router.
 * Patterns are copied here and must stay in sync with their source files:
 * - escapeHtml: gui/routes/apps.ts, gui/routes/logs.ts, gui/routes/llm-usage.ts
 * - escapeMarkdown: services/router/index.ts
 * - MODEL_ID_PATTERN: gui/routes/llm-usage.ts
 * - userId/appId patterns: gui/routes/apps.ts, gui/routes/config.ts
 * - MAX_TAIL_BYTES: gui/routes/logs.ts
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Copied security patterns — keep in sync with source files
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeMarkdown(text: string): string {
	return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,100}$/;

const APPID_PATTERN = /^[a-z0-9-]+$/;
const USERID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const MAX_TAIL_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
	it('escapes ampersand', () => {
		expect(escapeHtml('a&b')).toBe('a&amp;b');
	});

	it('escapes less-than', () => {
		expect(escapeHtml('a<b')).toBe('a&lt;b');
	});

	it('escapes greater-than', () => {
		expect(escapeHtml('a>b')).toBe('a&gt;b');
	});

	it('escapes double quotes', () => {
		expect(escapeHtml('a"b')).toBe('a&quot;b');
	});

	it('escapes single quotes', () => {
		expect(escapeHtml("a'b")).toBe('a&#39;b');
	});

	it('handles multiple special characters in one string', () => {
		expect(escapeHtml('<script>alert("xss")</script>')).toBe(
			'&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
		);
	});

	it('returns empty string unchanged', () => {
		expect(escapeHtml('')).toBe('');
	});

	it('handles string with no special characters unchanged', () => {
		expect(escapeHtml('hello world 123')).toBe('hello world 123');
	});

	it('handles string of ONLY special characters', () => {
		expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
	});
});

describe('escapeMarkdown', () => {
	it('escapes underscore', () => {
		expect(escapeMarkdown('a_b')).toBe('a\\_b');
	});

	it('escapes asterisk', () => {
		expect(escapeMarkdown('a*b')).toBe('a\\*b');
	});

	it('escapes brackets', () => {
		expect(escapeMarkdown('[link](url)')).toBe('\\[link\\]\\(url\\)');
	});

	it('escapes backtick', () => {
		expect(escapeMarkdown('a`b')).toBe('a\\`b');
	});

	it('handles multiple markdown characters', () => {
		expect(escapeMarkdown('**bold** _italic_ `code`')).toBe(
			'\\*\\*bold\\*\\* \\_italic\\_ \\`code\\`',
		);
	});

	it('returns plain text unchanged', () => {
		expect(escapeMarkdown('hello world 123')).toBe('hello world 123');
	});

	it('handles empty string', () => {
		expect(escapeMarkdown('')).toBe('');
	});
});

describe('MODEL_ID_PATTERN', () => {
	it('accepts claude-sonnet-4-20250514', () => {
		expect(MODEL_ID_PATTERN.test('claude-sonnet-4-20250514')).toBe(true);
	});

	it('accepts gpt-4o', () => {
		expect(MODEL_ID_PATTERN.test('gpt-4o')).toBe(true);
	});

	it('accepts gemini-2.0-flash', () => {
		expect(MODEL_ID_PATTERN.test('gemini-2.0-flash')).toBe(true);
	});

	it('accepts o3-mini', () => {
		expect(MODEL_ID_PATTERN.test('o3-mini')).toBe(true);
	});

	it('rejects model ID with spaces', () => {
		expect(MODEL_ID_PATTERN.test('gpt 4o')).toBe(false);
	});

	it('rejects model ID with slashes', () => {
		expect(MODEL_ID_PATTERN.test('models/gpt-4o')).toBe(false);
	});

	it('rejects model ID with angle brackets (XSS)', () => {
		expect(MODEL_ID_PATTERN.test('<script>alert(1)</script>')).toBe(false);
	});

	it('rejects model ID over 100 chars', () => {
		expect(MODEL_ID_PATTERN.test('a'.repeat(101))).toBe(false);
	});

	it('rejects empty string', () => {
		expect(MODEL_ID_PATTERN.test('')).toBe(false);
	});

	it('rejects model ID with backticks', () => {
		expect(MODEL_ID_PATTERN.test('model`name')).toBe(false);
	});
});

describe('userId/appId format validation', () => {
	describe('appId pattern', () => {
		it('accepts lowercase with hyphens (echo-app)', () => {
			expect(APPID_PATTERN.test('echo-app')).toBe(true);
		});

		it('accepts lowercase with hyphens (my-app-1)', () => {
			expect(APPID_PATTERN.test('my-app-1')).toBe(true);
		});

		it('rejects uppercase (EchoApp)', () => {
			expect(APPID_PATTERN.test('EchoApp')).toBe(false);
		});

		it('rejects spaces', () => {
			expect(APPID_PATTERN.test('echo app')).toBe(false);
		});

		it('rejects slashes', () => {
			expect(APPID_PATTERN.test('echo/app')).toBe(false);
		});

		it('rejects dots', () => {
			expect(APPID_PATTERN.test('echo.app')).toBe(false);
		});
	});

	describe('appId security', () => {
		it('rejects unicode characters', () => {
			expect(APPID_PATTERN.test('app-café')).toBe(false);
		});

		it('rejects emoji', () => {
			expect(APPID_PATTERN.test('app-🚀')).toBe(false);
		});

		it('rejects null bytes', () => {
			expect(APPID_PATTERN.test('app\x00id')).toBe(false);
		});
	});

	describe('userId pattern', () => {
		it('accepts alphanumeric with underscores (user_1)', () => {
			expect(USERID_PATTERN.test('user_1')).toBe(true);
		});

		it('accepts alphanumeric with hyphens (test-user)', () => {
			expect(USERID_PATTERN.test('test-user')).toBe(true);
		});

		it('accepts numeric-only (12345)', () => {
			expect(USERID_PATTERN.test('12345')).toBe(true);
		});

		it('rejects spaces', () => {
			expect(USERID_PATTERN.test('user 1')).toBe(false);
		});

		it('rejects slashes', () => {
			expect(USERID_PATTERN.test('user/1')).toBe(false);
		});

		it('rejects angle brackets', () => {
			expect(USERID_PATTERN.test('<script>')).toBe(false);
		});
	});
});

describe('MAX_TAIL_BYTES', () => {
	it('equals 512 * 1024 (512 KB)', () => {
		expect(MAX_TAIL_BYTES).toBe(524288);
	});
});
