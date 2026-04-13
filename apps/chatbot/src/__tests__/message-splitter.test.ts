/**
 * Tests for splitTelegramMessage() — splits long chatbot responses for Telegram (D1 phase).
 *
 * Telegram max message length is 4096 chars. We split at ~3800 chars.
 * Splitting priority: paragraphs (\n\n) → lines (\n) → hard chunk.
 * Markdown safety: don't split inside formatting spans when avoidable.
 */

import { describe, expect, it } from 'vitest';
import { splitTelegramMessage } from '../index.js';

const SPLIT_LIMIT = 3800;

describe('splitTelegramMessage', () => {
	it('returns single-element array for short messages', () => {
		const result = splitTelegramMessage('Hello world!');
		expect(result).toHaveLength(1);
		expect(result[0]).toBe('Hello world!');
	});

	it('returns single-element array for message at exactly the limit', () => {
		const text = 'a'.repeat(SPLIT_LIMIT);
		const result = splitTelegramMessage(text);
		expect(result).toHaveLength(1);
	});

	it('splits at paragraph boundary for message over limit', () => {
		const para1 = 'First paragraph. '.repeat(100); // ~1700 chars
		const para2 = 'Second paragraph. '.repeat(100); // ~1700 chars
		const para3 = 'Third paragraph. '.repeat(100); // ~1700 chars
		const text = `${para1}\n\n${para2}\n\n${para3}`;

		const result = splitTelegramMessage(text);

		expect(result.length).toBeGreaterThan(1);
		// Each part must be within Telegram limit
		for (const part of result) {
			expect(part.length).toBeLessThanOrEqual(4096);
		}
		// No content lost
		const rejoined = result.join('\n\n');
		expect(rejoined).toContain(para1.trim());
		expect(rejoined).toContain(para2.trim());
	});

	it('splits at line boundary when no paragraph fits', () => {
		// One huge paragraph with line breaks
		const line = 'A line of text that is about forty characters long.\n';
		const text = line.repeat(100); // ~5000 chars, no double newlines

		const result = splitTelegramMessage(text);

		expect(result.length).toBeGreaterThan(1);
		for (const part of result) {
			expect(part.length).toBeLessThanOrEqual(4096);
		}
	});

	it('falls back to hard chunk when no newlines exist', () => {
		const text = 'x'.repeat(8000); // 8000 chars, no newlines

		const result = splitTelegramMessage(text);

		expect(result.length).toBeGreaterThan(1);
		for (const part of result) {
			expect(part.length).toBeLessThanOrEqual(4096);
		}
		// All content preserved
		expect(result.join('')).toBe(text);
	});

	it('does not produce empty parts', () => {
		const text = `${'\n\n'.repeat(200)}Final content`;
		const result = splitTelegramMessage(text);
		for (const part of result) {
			expect(part.trim()).not.toBe('');
		}
	});

	it('preserves all content across splits', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: some content here`);
		const text = lines.join('\n');

		const parts = splitTelegramMessage(text);

		const rejoined = parts.join('\n');
		for (const line of lines) {
			expect(rejoined).toContain(line);
		}
	});

	it('accepts custom maxLength parameter', () => {
		const text = 'Hello world! '.repeat(10); // ~130 chars
		const result = splitTelegramMessage(text, 50);

		expect(result.length).toBeGreaterThan(1);
		for (const part of result) {
			expect(part.length).toBeLessThanOrEqual(50);
		}
	});
});
