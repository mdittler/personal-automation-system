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

		it('fail-open on non-matching prose (content present but no structured token line)', () => {
			// When the LLM returns unstructured prose, the parser cannot determine intent
			// and fails open (pasRelated=true) so the user still gets a useful response.
			const r = parsePASClassifierOutput('I think the user is asking about pasta?');
			expect(r.pasRelated).toBe(true);
			expect(r.settingsCandidate ?? false).toBe(false);
			expect(r.dataQueryCandidate ?? false).toBe(false);
		});

		it('ignores unknown tokens mixed with known tokens on same line', () => {
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

describe('parsePASClassifierOutput — robustness against prose/quoted tokens', () => {
	it('does not flip settingsCandidate from prose containing YES_SETTINGS', () => {
		const r = parsePASClassifierOutput(
			'The user seems to be asking about YES_SETTINGS based on context.\nNO_PAS NO_SETTINGS NO_DATA',
		);
		expect(r.settingsCandidate).toBe(false);
		expect(r.pasRelated).toBe(false);
	});

	it('NO_SETTINGS dominates YES_SETTINGS when both appear on token line', () => {
		const r = parsePASClassifierOutput('YES_PAS YES_SETTINGS NO_SETTINGS');
		expect(r.settingsCandidate).toBe(false);
		expect(r.pasRelated).toBe(true);
	});

	it('NO_PAS dominates YES_PAS when both appear', () => {
		const r = parsePASClassifierOutput('YES_PAS NO_PAS YES_SETTINGS NO_DATA');
		expect(r.pasRelated).toBe(false);
		expect(r.settingsCandidate).toBe(false);
	});

	it('settingsCandidate is false when pasRelated is false even if YES_SETTINGS present', () => {
		const r = parsePASClassifierOutput('NO_PAS YES_SETTINGS NO_DATA');
		expect(r.pasRelated).toBe(false);
		expect(r.settingsCandidate).toBe(false);
	});

	it('uses first structured token line and ignores subsequent explanation prose', () => {
		const r = parsePASClassifierOutput(
			'YES_PAS YES_SETTINGS NO_DATA\nThis is because the user asked about YES_PAS settings.',
		);
		expect(r.pasRelated).toBe(true);
		expect(r.settingsCandidate).toBe(true);
		expect(r.dataQueryCandidate).toBe(false);
	});

	it('unknown tokens on a line disqualify it as a structured token line', () => {
		// First line has "MAYBE" which is not a known token → skip to second line
		const r = parsePASClassifierOutput(
			'MAYBE_PAS YES_SETTINGS\nYES_PAS NO_SETTINGS NO_DATA',
		);
		expect(r.pasRelated).toBe(true);
		expect(r.settingsCandidate).toBe(false);
	});

	it('falls back to pasRelated=true when no structured token line found', () => {
		const r = parsePASClassifierOutput('I cannot determine the intent of this message.');
		expect(r.pasRelated).toBe(true); // fail-open
		expect(r.settingsCandidate).toBe(false);
		expect(r.dataQueryCandidate).toBe(false);
	});
});
