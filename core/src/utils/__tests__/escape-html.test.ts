import { describe, expect, it } from 'vitest';
import { escapeHtml, safeJsonForScript } from '../escape-html.js';

describe('escapeHtml', () => {
	it('escapes ampersands', () => {
		expect(escapeHtml('a & b')).toBe('a &amp; b');
	});

	it('escapes less-than', () => {
		expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
	});

	it('escapes greater-than', () => {
		expect(escapeHtml('a > b')).toBe('a &gt; b');
	});

	it('escapes double quotes', () => {
		expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
	});

	it('escapes single quotes', () => {
		expect(escapeHtml("it's")).toBe('it&#39;s');
	});

	it('escapes all special characters together', () => {
		expect(escapeHtml('<a href="x">&amp;</a>')).toBe(
			'&lt;a href=&quot;x&quot;&gt;&amp;amp;&lt;/a&gt;',
		);
	});

	it('passes safe strings through unchanged', () => {
		expect(escapeHtml('hello world 123')).toBe('hello world 123');
	});

	it('handles empty string', () => {
		expect(escapeHtml('')).toBe('');
	});
});

describe('safeJsonForScript', () => {
	it('produces no literal </script> sequence in output', () => {
		const result = safeJsonForScript({ name: 'evil </script><script>alert(1)</script>' });
		expect(result).not.toContain('</script>');
	});

	it('round-trips correctly — JSON.parse recovers the original value', () => {
		const original = { name: 'Alice </script> & Bob', count: 42 };
		const result = safeJsonForScript(original);
		expect(JSON.parse(result)).toEqual(original);
	});

	it('replaces < with \\u003c', () => {
		const result = safeJsonForScript('<tag>');
		expect(result).toContain('\\u003c');
		expect(result).not.toContain('<tag>');
	});

	it('does not alter > (only < is replaced)', () => {
		const result = safeJsonForScript('a > b');
		// > is not replaced
		expect(result).toContain('>');
	});

	it('handles arrays', () => {
		const data = [{ id: '1', name: 'Test </script>' }];
		const result = safeJsonForScript(data);
		expect(result).not.toContain('</script>');
		expect(JSON.parse(result)).toEqual(data);
	});

	it('handles empty array', () => {
		const result = safeJsonForScript([]);
		expect(result).toBe('[]');
	});

	it('handles null', () => {
		const result = safeJsonForScript(null);
		expect(result).toBe('null');
	});

	it('handles strings without < unchanged (except JSON quoting)', () => {
		const result = safeJsonForScript('hello world');
		expect(result).toBe('"hello world"');
	});
});
