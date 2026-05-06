import { describe, expect, it } from 'vitest';
import { parsePASClassifierOutput } from '../pas-classifier.js';

describe('parsePASClassifierOutput — backward-compatible protocol', () => {
	describe('legacy outputs (must still parse)', () => {
		it.each([
			['YES', true, false, false],
			['NO', false, false, false],
			['YES_DATA', true, true, false],
		])(
			'parses legacy "%s" → pasRelated=%s dataQuery=%s settings=%s',
			(raw, pas, data, settings) => {
				const r = parsePASClassifierOutput(raw);
				expect(r.pasRelated).toBe(pas);
				expect(r.dataQueryCandidate ?? false).toBe(data);
				expect(r.settingsCandidate ?? false).toBe(settings);
			},
		);
	});

	describe('new YES_SETTINGS / NO_SETTINGS tokens', () => {
		it('parses YES_PAS YES_SETTINGS NO_DATA', () => {
			const r = parsePASClassifierOutput('YES_PAS YES_SETTINGS NO_DATA');
			expect(r.pasRelated).toBe(true);
			expect(r.settingsCandidate).toBe(true);
			expect(r.dataQueryCandidate ?? false).toBe(false);
		});

		it('parses YES_PAS NO_SETTINGS YES_DATA', () => {
			const r = parsePASClassifierOutput('YES_PAS NO_SETTINGS YES_DATA');
			expect(r.pasRelated).toBe(true);
			expect(r.settingsCandidate ?? false).toBe(false);
			expect(r.dataQueryCandidate).toBe(true);
		});

		it('parses tokens in any order', () => {
			const r = parsePASClassifierOutput('NO_DATA YES_SETTINGS YES_PAS');
			expect(r.pasRelated).toBe(true);
			expect(r.settingsCandidate).toBe(true);
			expect(r.dataQueryCandidate ?? false).toBe(false);
		});
	});

	describe('garbage / partial output', () => {
		it('returns all false on empty string', () => {
			const r = parsePASClassifierOutput('');
			expect(r.pasRelated).toBe(false);
			expect(r.dataQueryCandidate ?? false).toBe(false);
			expect(r.settingsCandidate ?? false).toBe(false);
		});

		it('returns all false on non-matching prose', () => {
			const r = parsePASClassifierOutput('I think the user is asking about pasta?');
			expect(r.pasRelated).toBe(false);
			expect(r.settingsCandidate ?? false).toBe(false);
		});

		it('ignores unknown tokens', () => {
			const r = parsePASClassifierOutput('YES_PAS NO_SETTINGS HALLUCINATED_TOKEN');
			expect(r.pasRelated).toBe(true);
			expect(r.settingsCandidate ?? false).toBe(false);
		});
	});

	describe('case + punctuation tolerance', () => {
		it('accepts lowercase tokens', () => {
			const r = parsePASClassifierOutput('yes_pas yes_settings');
			expect(r.pasRelated).toBe(true);
			expect(r.settingsCandidate).toBe(true);
		});

		it('accepts mixed case', () => {
			const r = parsePASClassifierOutput('Yes_Pas YES_settings no_data');
			expect(r.pasRelated).toBe(true);
			expect(r.settingsCandidate).toBe(true);
			expect(r.dataQueryCandidate ?? false).toBe(false);
		});

		it('tolerates surrounding punctuation', () => {
			const r = parsePASClassifierOutput('"YES_PAS", "YES_SETTINGS".');
			expect(r.pasRelated).toBe(true);
			expect(r.settingsCandidate).toBe(true);
		});
	});
});
