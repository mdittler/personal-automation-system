/**
 * Unit tests for matchesDangerConfirmPhrase.
 *
 * REQ-SETTINGS-027: phrase match MUST use constant-time comparison.
 */
import { describe, expect, it } from 'vitest';
import { matchesDangerConfirmPhrase } from '../settings-confirm-helpers.js';

describe('matchesDangerConfirmPhrase', () => {
	it('returns true for identical strings', () => {
		expect(matchesDangerConfirmPhrase('confirm this action', 'confirm this action')).toBe(true);
	});

	it('returns true for empty strings', () => {
		expect(matchesDangerConfirmPhrase('', '')).toBe(true);
	});

	it('returns false for different lengths (shorter submitted)', () => {
		expect(matchesDangerConfirmPhrase('confirm', 'confirm this action')).toBe(false);
	});

	it('returns false for different lengths (longer submitted)', () => {
		expect(matchesDangerConfirmPhrase('confirm this action extra', 'confirm this action')).toBe(false);
	});

	it('returns false for same-length strings with one-byte difference', () => {
		// 'abc' vs 'abd' — same length, different last byte
		expect(matchesDangerConfirmPhrase('abc', 'abd')).toBe(false);
	});

	it('returns false for case mismatch (uppercased)', () => {
		expect(matchesDangerConfirmPhrase('CONFIRM THIS ACTION', 'confirm this action')).toBe(false);
	});

	it('returns false for leading whitespace', () => {
		expect(matchesDangerConfirmPhrase(' confirm this action', 'confirm this action')).toBe(false);
	});

	it('returns false for trailing whitespace', () => {
		expect(matchesDangerConfirmPhrase('confirm this action ', 'confirm this action')).toBe(false);
	});

	it('returns false for truncated phrase (first half only)', () => {
		const expected = 'confirm this action';
		const submitted = expected.slice(0, Math.floor(expected.length / 2));
		expect(matchesDangerConfirmPhrase(submitted, expected)).toBe(false);
	});

	it('handles non-ASCII UTF-8 correctly', () => {
		const phrase = 'confirmé cette action';
		expect(matchesDangerConfirmPhrase(phrase, phrase)).toBe(true);
		expect(matchesDangerConfirmPhrase('confirme cette action', phrase)).toBe(false);
	});

	it('returns false for cross-key mismatch (wrong phrase for this key)', () => {
		const promptA = 'enable auto prune';
		const promptB = 'enable shadow routing';
		expect(matchesDangerConfirmPhrase(promptB, promptA)).toBe(false);
	});

	it('single character identical', () => {
		expect(matchesDangerConfirmPhrase('x', 'x')).toBe(true);
	});

	it('single character different', () => {
		expect(matchesDangerConfirmPhrase('x', 'y')).toBe(false);
	});
});
