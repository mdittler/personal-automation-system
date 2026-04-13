import { describe, it, expect } from 'vitest';
import { STOP_WORDS } from '../stopwords.js';

describe('STOP_WORDS', () => {
	describe('English stop words', () => {
		it('contains common English glue words', () => {
			expect(STOP_WORDS.has('the')).toBe(true);
			expect(STOP_WORDS.has('and')).toBe(true);
			expect(STOP_WORDS.has('with')).toBe(true);
			expect(STOP_WORDS.has('ate')).toBe(true);
		});
	});

	describe('German glue words', () => {
		it('contains German articles', () => {
			expect(STOP_WORDS.has('das')).toBe(true);
			expect(STOP_WORDS.has('der')).toBe(true);
			expect(STOP_WORDS.has('die')).toBe(true);
			expect(STOP_WORDS.has('ein')).toBe(true);
			expect(STOP_WORDS.has('eine')).toBe(true);
		});

		it('contains German conjunctions and pronouns', () => {
			expect(STOP_WORDS.has('und')).toBe(true);
			expect(STOP_WORDS.has('mit')).toBe(true);
			expect(STOP_WORDS.has('ich')).toBe(true);
		});

		it('contains German meal verbs and prepositions', () => {
			expect(STOP_WORDS.has('habe')).toBe(true);
			expect(STOP_WORDS.has('hatte')).toBe(true);
			expect(STOP_WORDS.has('zum')).toBe(true);
			expect(STOP_WORDS.has('vom')).toBe(true);
			expect(STOP_WORDS.has('beim')).toBe(true);
		});
	});

	describe('French glue words', () => {
		it('contains French articles', () => {
			expect(STOP_WORDS.has('le')).toBe(true);
			expect(STOP_WORDS.has('la')).toBe(true);
			expect(STOP_WORDS.has('les')).toBe(true);
			expect(STOP_WORDS.has('un')).toBe(true);
			expect(STOP_WORDS.has('une')).toBe(true);
			expect(STOP_WORDS.has('du')).toBe(true);
			expect(STOP_WORDS.has('des')).toBe(true);
		});

		it('contains French conjunctions and prepositions', () => {
			expect(STOP_WORDS.has('et')).toBe(true);
			expect(STOP_WORDS.has('avec')).toBe(true);
			expect(STOP_WORDS.has('pour')).toBe(true);
		});

		it('contains French meal-related words', () => {
			expect(STOP_WORDS.has('ai')).toBe(true);
			expect(STOP_WORDS.has('mange')).toBe(true);
			expect(STOP_WORDS.has('repas')).toBe(true);
			expect(STOP_WORDS.has('mon')).toBe(true);
			expect(STOP_WORDS.has('ma')).toBe(true);
		});
	});

	describe('Spanish glue words', () => {
		it('contains Spanish articles', () => {
			expect(STOP_WORDS.has('el')).toBe(true);
			expect(STOP_WORDS.has('los')).toBe(true);
			expect(STOP_WORDS.has('las')).toBe(true);
			expect(STOP_WORDS.has('una')).toBe(true);
			expect(STOP_WORDS.has('del')).toBe(true);
		});

		it('contains Spanish conjunctions and prepositions', () => {
			expect(STOP_WORDS.has('con')).toBe(true);
			expect(STOP_WORDS.has('para')).toBe(true);
			expect(STOP_WORDS.has('por')).toBe(true);
		});

		it('contains Spanish meal-related words', () => {
			expect(STOP_WORDS.has('comi')).toBe(true);
			expect(STOP_WORDS.has('comida')).toBe(true);
			expect(STOP_WORDS.has('mi')).toBe(true);
			expect(STOP_WORDS.has('mis')).toBe(true);
			expect(STOP_WORDS.has('fue')).toBe(true);
		});
	});

	describe('food identity words are NOT stop words', () => {
		it('does not contain German food identity words', () => {
			expect(STOP_WORDS.has('schnitzel')).toBe(false);
			expect(STOP_WORDS.has('bratwurst')).toBe(false);
			expect(STOP_WORDS.has('sauerkraut')).toBe(false);
		});

		it('does not contain French food identity words', () => {
			expect(STOP_WORDS.has('baguette')).toBe(false);
			expect(STOP_WORDS.has('croissant')).toBe(false);
			expect(STOP_WORDS.has('quiche')).toBe(false);
		});

		it('does not contain Spanish food identity words', () => {
			expect(STOP_WORDS.has('paella')).toBe(false);
			expect(STOP_WORDS.has('empanada')).toBe(false);
			expect(STOP_WORDS.has('chorizo')).toBe(false);
		});

		it('does not contain generic food identity words', () => {
			expect(STOP_WORDS.has('pizza')).toBe(false);
			expect(STOP_WORDS.has('pasta')).toBe(false);
			expect(STOP_WORDS.has('chicken')).toBe(false);
		});
	});
});
