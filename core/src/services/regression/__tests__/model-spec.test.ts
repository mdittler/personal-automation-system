/**
 * Unit tests for the shared regression model-spec parser.
 *
 * Single source of truth used by both:
 *   - the regression CLI (`regression/src/runner/args.ts`)
 *   - the regression GUI POST handler (`core/src/gui/routes/regression.ts`)
 *
 * Tightened semantics (Batch 1 of REQ-REG-GUI-OV) reject shell metacharacters,
 * traversal sequences, control characters, and HTML payloads — closing the
 * defense-in-depth gap Codex flagged on the original "verbatim copy" plan.
 */
import { describe, expect, it } from 'vitest';

import {
	MAX_MODEL_SPEC_CHARS,
	normalizeOptionalModelSpec,
	parseJudgeModelValue,
	parseModelMatrixValue,
	parseModelRef,
} from '../model-spec.js';

// ─── Batch 1.A — parseModelRef ────────────────────────────────────────────────
describe('parseModelRef', () => {
	// Happy path
	it('accepts anthropic/claude-sonnet-4-6', () => {
		expect(parseModelRef('anthropic/claude-sonnet-4-6')).toEqual({
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
		});
	});

	it('accepts ollama/gemma4:e4b (colon in model)', () => {
		expect(parseModelRef('ollama/gemma4:e4b')).toEqual({
			provider: 'ollama',
			model: 'gemma4:e4b',
		});
	});

	it('accepts google/gemini-2.0-flash (dot in model)', () => {
		expect(parseModelRef('google/gemini-2.0-flash')).toEqual({
			provider: 'google',
			model: 'gemini-2.0-flash',
		});
	});

	it('accepts openai-compat/gpt-4o (hyphen in provider)', () => {
		expect(parseModelRef('openai-compat/gpt-4o')).toEqual({
			provider: 'openai-compat',
			model: 'gpt-4o',
		});
	});

	it('accepts long real-world id ollama/gemma4:26b', () => {
		expect(parseModelRef('ollama/gemma4:26b')).toEqual({
			provider: 'ollama',
			model: 'gemma4:26b',
		});
	});

	// Edge
	it("rejects '' (empty)", () => {
		expect(() => parseModelRef('')).toThrow(/provider\/model/i);
	});

	it("rejects 'no-slash' (no separator)", () => {
		expect(() => parseModelRef('no-slash')).toThrow(/provider\/model/i);
	});

	it("rejects '/claude' (empty provider)", () => {
		expect(() => parseModelRef('/claude')).toThrow(/provider/i);
	});

	it("rejects 'anthropic/' (empty model)", () => {
		expect(() => parseModelRef('anthropic/')).toThrow(/model/i);
	});

	it("rejects 'a/b/c' (extra slash — model contains /)", () => {
		// split on first /, model = 'b/c' → fails MODEL_RE
		expect(() => parseModelRef('a/b/c')).toThrow();
	});

	it("rejects 'ANTHROPIC/claude' (uppercase provider)", () => {
		expect(() => parseModelRef('ANTHROPIC/claude')).toThrow(/provider/i);
	});

	it("rejects '-anthropic/claude' (leading hyphen in provider)", () => {
		expect(() => parseModelRef('-anthropic/claude')).toThrow(/provider/i);
	});

	// Security
	it("rejects 'ollama/gemma;rm' (semicolon)", () => {
		expect(() => parseModelRef('ollama/gemma;rm')).toThrow();
	});

	it("rejects 'ollama/$(evil)' (subshell chars)", () => {
		expect(() => parseModelRef('ollama/$(evil)')).toThrow();
	});

	it('rejects ollama/foo`bar` (backticks)', () => {
		expect(() => parseModelRef('ollama/foo`bar`')).toThrow();
	});

	it("rejects 'ollama/foo&bar' (shell control)", () => {
		expect(() => parseModelRef('ollama/foo&bar')).toThrow();
	});

	it("rejects 'ollama/foo|bar' (pipe)", () => {
		expect(() => parseModelRef('ollama/foo|bar')).toThrow();
	});

	it("rejects 'ollama/foo>bar' (HTML/redirect)", () => {
		expect(() => parseModelRef('ollama/foo>bar')).toThrow();
	});

	it("rejects 'ollama/<script>' (HTML tag)", () => {
		expect(() => parseModelRef('ollama/<script>')).toThrow();
	});

	it("rejects 'ollama/../etc' (traversal)", () => {
		expect(() => parseModelRef('ollama/../etc')).toThrow();
	});

	it("rejects 'ollama/foo bar' (whitespace in model)", () => {
		expect(() => parseModelRef('ollama/foo bar')).toThrow();
	});

	it('rejects ollama/foo\\nbar (newline control char)', () => {
		expect(() => parseModelRef('ollama/foo\nbar')).toThrow();
	});

	// Edge: length
	it('rejects when provider is longer than allowed', () => {
		const provider = 'a'.repeat(200);
		expect(() => parseModelRef(`${provider}/claude`)).toThrow();
	});

	it('rejects when model is longer than allowed', () => {
		const model = 'a'.repeat(200);
		expect(() => parseModelRef(`ollama/${model}`)).toThrow();
	});

	it('rejects when total spec exceeds MAX_MODEL_SPEC_CHARS / 2', () => {
		// MAX_MODEL_SPEC_CHARS is 256, so single-ref cap is 128.
		const longSpec = `ollama/${'a'.repeat(MAX_MODEL_SPEC_CHARS)}`;
		expect(() => parseModelRef(longSpec)).toThrow(/exceeds|too long|too large/i);
	});
});

// ─── Batch 1.B — parseModelMatrixValue ────────────────────────────────────────
describe('parseModelMatrixValue', () => {
	// Happy path
	it("parses 'fast=ollama/gemma4:31b' (single named tier)", () => {
		expect(parseModelMatrixValue('fast=ollama/gemma4:31b')).toEqual({
			fast: { provider: 'ollama', model: 'gemma4:31b' },
		});
	});

	it('parses two named tiers', () => {
		expect(
			parseModelMatrixValue('fast=ollama/gemma4:31b,standard=anthropic/claude-sonnet-4-6'),
		).toEqual({
			fast: { provider: 'ollama', model: 'gemma4:31b' },
			standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
		});
	});

	it('parses three positional tiers (fast, standard, reasoning)', () => {
		expect(
			parseModelMatrixValue(
				'ollama/gemma4:31b,anthropic/claude-sonnet-4-6,anthropic/claude-opus-4-7',
			),
		).toEqual({
			fast: { provider: 'ollama', model: 'gemma4:31b' },
			standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
			reasoning: { provider: 'anthropic', model: 'claude-opus-4-7' },
		});
	});

	// Edge
	it("rejects '' (empty value)", () => {
		expect(() => parseModelMatrixValue('')).toThrow(/empty|requires a value/i);
	});

	it("rejects ',' (comma-only — Codex item 9)", () => {
		expect(() => parseModelMatrixValue(',')).toThrow(/empty|requires a value/i);
	});

	it("rejects ',,,,' (all-empty entries — Codex item 9)", () => {
		expect(() => parseModelMatrixValue(',,,,')).toThrow(/empty|requires a value/i);
	});

	it('rejects duplicate tier assignment (Codex item 9)', () => {
		expect(() => parseModelMatrixValue('fast=ollama/x,fast=anthropic/y')).toThrow(
			/duplicate|already.*set|conflict/i,
		);
	});

	it('rejects positional followed by named conflict on the same tier (Codex item 9)', () => {
		// First entry "ollama/x" lands in fast (positional); second "fast=anthropic/y" conflicts.
		expect(() => parseModelMatrixValue('ollama/x,fast=anthropic/y')).toThrow(
			/duplicate|already.*set|conflict/i,
		);
	});

	it("rejects 'tier1=foo/bar' (bad tier name)", () => {
		expect(() => parseModelMatrixValue('tier1=foo/bar')).toThrow(/tier/i);
	});

	it('rejects four positional entries (too many)', () => {
		expect(() => parseModelMatrixValue('a/b,c/d,e/f,extra/g')).toThrow(/too many|max|positional/i);
	});

	// Security
	it('rejects when value exceeds MAX_MODEL_SPEC_CHARS (length cap)', () => {
		expect(() => parseModelMatrixValue('a'.repeat(MAX_MODEL_SPEC_CHARS + 10))).toThrow(
			/exceeds|too long|too large/i,
		);
	});

	it("rejects 'fast=ollama/gemma;rm' (delegated security via parseModelRef)", () => {
		expect(() => parseModelMatrixValue('fast=ollama/gemma;rm')).toThrow();
	});
});

// ─── Batch 1.C — parseJudgeModelValue ─────────────────────────────────────────
describe('parseJudgeModelValue', () => {
	it('accepts anthropic/claude-haiku-4-5-20251001', () => {
		expect(parseJudgeModelValue('anthropic/claude-haiku-4-5-20251001')).toEqual({
			provider: 'anthropic',
			model: 'claude-haiku-4-5-20251001',
		});
	});

	it("rejects '' (empty)", () => {
		expect(() => parseJudgeModelValue('')).toThrow(/empty|requires|provider\/model/i);
	});

	it("rejects 'anthropic/claude;rm' (security)", () => {
		expect(() => parseJudgeModelValue('anthropic/claude;rm')).toThrow();
	});

	it('rejects values longer than MAX_MODEL_SPEC_CHARS / 2 (length cap)', () => {
		expect(() => parseJudgeModelValue('a'.repeat(200))).toThrow(/exceeds|too long|too large/i);
	});
});

// ─── Batch 1.D — normalizeOptionalModelSpec ───────────────────────────────────
describe('normalizeOptionalModelSpec', () => {
	it('returns undefined for undefined', () => {
		expect(normalizeOptionalModelSpec(undefined)).toBeUndefined();
	});

	it('returns undefined for null', () => {
		expect(normalizeOptionalModelSpec(null)).toBeUndefined();
	});

	it("returns undefined for '' (empty string)", () => {
		expect(normalizeOptionalModelSpec('')).toBeUndefined();
	});

	it("returns undefined for '   ' (whitespace-only)", () => {
		expect(normalizeOptionalModelSpec('   ')).toBeUndefined();
	});

	it('passes through a clean string unchanged', () => {
		expect(normalizeOptionalModelSpec('fast=ollama/gemma4:31b')).toBe('fast=ollama/gemma4:31b');
	});

	it('trims leading/trailing whitespace', () => {
		expect(normalizeOptionalModelSpec('  fast=ollama/gemma4:31b  ')).toBe('fast=ollama/gemma4:31b');
	});

	// Security: non-string types must throw, not coerce
	it('throws TypeError for arrays', () => {
		expect(() => normalizeOptionalModelSpec([] as unknown)).toThrow(TypeError);
	});

	it('throws TypeError for objects', () => {
		expect(() => normalizeOptionalModelSpec({} as unknown)).toThrow(TypeError);
	});

	it('throws TypeError for numbers', () => {
		expect(() => normalizeOptionalModelSpec(42 as unknown)).toThrow(TypeError);
	});

	it('throws TypeError for booleans', () => {
		expect(() => normalizeOptionalModelSpec(true as unknown)).toThrow(TypeError);
	});

	// Length cap
	it('throws RangeError when input exceeds MAX_MODEL_SPEC_CHARS', () => {
		expect(() => normalizeOptionalModelSpec('a'.repeat(MAX_MODEL_SPEC_CHARS + 1))).toThrow(
			RangeError,
		);
	});
});
