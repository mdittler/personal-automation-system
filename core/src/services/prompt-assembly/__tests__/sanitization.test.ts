import { describe, expect, it } from 'vitest';
import { sanitizeInput } from '../sanitization.js';

describe('sanitizeInput', () => {
	it('passes through normal text', () => {
		expect(sanitizeInput('hello world')).toBe('hello world');
	});

	it('neutralizes triple backticks', () => {
		expect(sanitizeInput('```code```')).toBe('`code`');
	});

	it('neutralizes long backtick sequences', () => {
		expect(sanitizeInput('`````')).toBe('`');
	});

	it('truncates text exceeding maxLength', () => {
		expect(sanitizeInput('a'.repeat(5000), 100)).toHaveLength(100);
	});

	it('preserves text at exactly maxLength', () => {
		expect(sanitizeInput('a'.repeat(100), 100)).toHaveLength(100);
	});

	it('does NOT neutralize U+FF40 fullwidth grave accents (parity with chatbot regex)', () => {
		const ff40 = '｀｀｀code｀｀｀';
		expect(sanitizeInput(ff40)).toBe(ff40);
	});
});
