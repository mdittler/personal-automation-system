/**
 * `isValidModelId` — the single model-id validator shared by the GUI tier
 * routes, the chatbot `<switch-model>` path (system-info) and the regression
 * `--model-matrix` parser.
 *
 * The point of the shared validator is that a model id which can be
 * regression-tested must also be assignable to a tier: before it existed the
 * GUI and system-info rejected `/`, so an Ollama model pulled from HuggingFace
 * (`hf.co/<org>/<repo>:<quant>`) could be benchmarked but never promoted.
 */

import { describe, expect, it } from 'vitest';
import { MAX_MODEL_ID_CHARS, MODEL_ID_PATTERN, isValidModelId } from '../model-id.js';

describe('isValidModelId', () => {
	describe('accepts real-world model ids', () => {
		it('accepts a plain vendor id', () => {
			expect(isValidModelId('claude-sonnet-4-20250514')).toBe(true);
		});

		it('accepts dots and colons (Ollama tag syntax)', () => {
			expect(isValidModelId('qwen2.5:14b-instruct')).toBe(true);
		});

		it('accepts underscores', () => {
			expect(isValidModelId('Foo_Bar_v2')).toBe(true);
		});

		it('accepts a HuggingFace-namespaced id', () => {
			expect(isValidModelId('meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe(true);
		});

		it('accepts an Ollama-from-HuggingFace id with host, namespace and quant tag', () => {
			expect(isValidModelId('hf.co/bartowski/Foo-GGUF:Q4_K_M')).toBe(true);
		});

		it('accepts a Google "models/" prefixed id', () => {
			expect(isValidModelId('models/gemini-2.0-flash')).toBe(true);
		});

		it('accepts exactly the maximum length', () => {
			expect(isValidModelId('a'.repeat(MAX_MODEL_ID_CHARS))).toBe(true);
		});
	});

	describe('rejects malformed input', () => {
		it('rejects a non-string', () => {
			expect(isValidModelId(undefined)).toBe(false);
			expect(isValidModelId(null)).toBe(false);
			expect(isValidModelId(42)).toBe(false);
			expect(isValidModelId({ toString: () => 'gpt-4o' })).toBe(false);
		});

		it('rejects the empty string', () => {
			expect(isValidModelId('')).toBe(false);
		});

		it('rejects one character over the maximum length', () => {
			expect(isValidModelId('a'.repeat(MAX_MODEL_ID_CHARS + 1))).toBe(false);
		});

		it('rejects whitespace', () => {
			expect(isValidModelId('gpt 4o')).toBe(false);
			expect(isValidModelId(' gpt-4o')).toBe(false);
			expect(isValidModelId('gpt-4o\n')).toBe(false);
			expect(isValidModelId('gpt-4o\t')).toBe(false);
		});

		it('rejects a non-alphanumeric first character', () => {
			expect(isValidModelId('-gpt-4o')).toBe(false);
			expect(isValidModelId('.gpt-4o')).toBe(false);
			expect(isValidModelId('/gpt-4o')).toBe(false);
			expect(isValidModelId(':gpt-4o')).toBe(false);
			expect(isValidModelId('_gpt-4o')).toBe(false);
		});
	});

	describe('rejects injection and traversal payloads', () => {
		it('rejects "." traversal sequences', () => {
			expect(isValidModelId('../../../etc/passwd')).toBe(false);
			expect(isValidModelId('hf.co/../../../etc/passwd')).toBe(false);
			expect(isValidModelId('a..b')).toBe(false);
		});

		it('rejects empty path segments', () => {
			expect(isValidModelId('hf.co//bartowski/Foo')).toBe(false);
		});

		it('rejects a trailing separator', () => {
			expect(isValidModelId('hf.co/bartowski/')).toBe(false);
		});

		it('rejects HTML/XSS payloads', () => {
			expect(isValidModelId('<script>alert(1)</script>')).toBe(false);
			expect(isValidModelId('gpt-4o"onload="x')).toBe(false);
		});

		it('rejects shell metacharacters', () => {
			for (const bad of [
				'model`name',
				'model$(id)',
				'model;rm -rf /',
				'model|cat',
				'model&whoami',
				'model>out',
				"model'q",
				'model\\name',
			]) {
				expect(isValidModelId(bad)).toBe(false);
			}
		});

		it('rejects control characters and null bytes', () => {
			expect(isValidModelId('gpt-4o\u0000')).toBe(false);
			expect(isValidModelId('gpt-4o\u0007')).toBe(false);
			expect(isValidModelId('gpt-4o\u001b[31m')).toBe(false);
		});

		it('rejects non-ASCII homoglyphs', () => {
			expect(isValidModelId('gpt-4\u043e')).toBe(false); // Cyrillic "o"
			expect(isValidModelId('\u6a21\u578b')).toBe(false);
		});

		it('is fully anchored — a valid id embedded in junk is rejected', () => {
			expect(isValidModelId('junk\ngpt-4o')).toBe(false);
			expect(MODEL_ID_PATTERN.source.startsWith('^')).toBe(true);
			expect(MODEL_ID_PATTERN.source.endsWith('$')).toBe(true);
		});
	});
});
