import { describe, expect, it } from 'vitest';
import {
	DEPARTMENTS,
	DEPARTMENT_MAP,
	assignDepartment,
	parseManualItems,
} from '../services/item-parser.js';

describe('item-parser', () => {
	describe('DEPARTMENTS', () => {
		it('contains standard grocery departments', () => {
			expect(DEPARTMENTS).toContain('Produce');
			expect(DEPARTMENTS).toContain('Dairy & Eggs');
			expect(DEPARTMENTS).toContain('Meat & Seafood');
			expect(DEPARTMENTS).toContain('Bakery');
			expect(DEPARTMENTS).toContain('Frozen');
			expect(DEPARTMENTS).toContain('Pantry & Dry Goods');
			expect(DEPARTMENTS).toContain('Beverages');
			expect(DEPARTMENTS).toContain('Snacks');
			expect(DEPARTMENTS).toContain('Household');
			expect(DEPARTMENTS).toContain('Other');
		});
	});

	describe('DEPARTMENT_MAP', () => {
		it('maps common items to departments', () => {
			expect(DEPARTMENT_MAP['milk']).toBe('Dairy & Eggs');
			expect(DEPARTMENT_MAP['chicken']).toBe('Meat & Seafood');
			expect(DEPARTMENT_MAP['bread']).toBe('Bakery');
			expect(DEPARTMENT_MAP['spinach']).toBe('Produce');
		});
	});

	describe('assignDepartment', () => {
		it('exact match returns correct department', () => {
			expect(assignDepartment('milk')).toBe('Dairy & Eggs');
			expect(assignDepartment('bread')).toBe('Bakery');
			expect(assignDepartment('salmon')).toBe('Meat & Seafood');
			expect(assignDepartment('chips')).toBe('Snacks');
		});

		it('multi-word exact match', () => {
			expect(assignDepartment('chicken breast')).toBe('Meat & Seafood');
			expect(assignDepartment('olive oil')).toBe('Pantry & Dry Goods');
			expect(assignDepartment('paper towels')).toBe('Household');
			expect(assignDepartment('ice cream')).toBe('Frozen');
		});

		it('substring match for items containing a known key', () => {
			expect(assignDepartment('organic chicken breast')).toBe('Meat & Seafood');
			expect(assignDepartment('fresh spinach')).toBe('Produce');
			expect(assignDepartment('whole wheat bread')).toBe('Bakery');
			expect(assignDepartment('low-fat milk')).toBe('Dairy & Eggs');
		});

		it('returns "Other" for unknown items', () => {
			expect(assignDepartment('dragon fruit candy')).toBe('Other');
			expect(assignDepartment('xyz123')).toBe('Other');
			expect(assignDepartment('random thing')).toBe('Other');
		});

		it('is case insensitive', () => {
			expect(assignDepartment('MILK')).toBe('Dairy & Eggs');
			expect(assignDepartment('Chicken Breast')).toBe('Meat & Seafood');
			expect(assignDepartment('BREAD')).toBe('Bakery');
			expect(assignDepartment('Olive Oil')).toBe('Pantry & Dry Goods');
		});

		it('returns "Other" for empty string', () => {
			expect(assignDepartment('')).toBe('Other');
		});

		it('returns "Other" for whitespace-only input', () => {
			expect(assignDepartment('   ')).toBe('Other');
			expect(assignDepartment('\t')).toBe('Other');
		});

		it('trims whitespace before matching', () => {
			expect(assignDepartment('  milk  ')).toBe('Dairy & Eggs');
			expect(assignDepartment('\tchicken\t')).toBe('Meat & Seafood');
		});
	});

	describe('parseManualItems', () => {
		const userId = 'user-123';

		it('parses a simple item with no quantity or unit', () => {
			const result = parseManualItems('milk', userId);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('milk');
			expect(result[0].quantity).toBeNull();
			expect(result[0].unit).toBeNull();
		});

		it('parses item with quantity only (no unit)', () => {
			const result = parseManualItems('2 eggs', userId);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('eggs');
			expect(result[0].quantity).toBe(2);
			expect(result[0].unit).toBeNull();
		});

		it('parses item with quantity and unit', () => {
			const result = parseManualItems('2 lbs chicken', userId);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('chicken');
			expect(result[0].quantity).toBe(2);
			expect(result[0].unit).toBe('lbs');
		});

		it('parses decimal quantity', () => {
			const result = parseManualItems('1.5 cups flour', userId);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('flour');
			expect(result[0].quantity).toBe(1.5);
			expect(result[0].unit).toBe('cups');
		});

		it('parses multiple items separated by commas', () => {
			const result = parseManualItems('milk, eggs, bread', userId);
			expect(result).toHaveLength(3);
			expect(result[0].name).toBe('milk');
			expect(result[1].name).toBe('eggs');
			expect(result[2].name).toBe('bread');
		});

		it('parses multiple items separated by "and"', () => {
			const result = parseManualItems('milk and eggs', userId);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('milk');
			expect(result[1].name).toBe('eggs');
		});

		it('parses multiple items separated by newlines', () => {
			const result = parseManualItems('milk\neggs\nbread', userId);
			expect(result).toHaveLength(3);
			expect(result[0].name).toBe('milk');
			expect(result[1].name).toBe('eggs');
			expect(result[2].name).toBe('bread');
		});

		it('assigns departments from lookup', () => {
			const result = parseManualItems('milk, chicken, bread, chips', userId);
			expect(result[0].department).toBe('Dairy & Eggs');
			expect(result[1].department).toBe('Meat & Seafood');
			expect(result[2].department).toBe('Bakery');
			expect(result[3].department).toBe('Snacks');
		});

		it('assigns "Other" department for unknown items', () => {
			const result = parseManualItems('stapler', userId);
			expect(result[0].department).toBe('Other');
		});

		it('sets addedBy to the provided userId', () => {
			const result = parseManualItems('milk', 'user-456');
			expect(result[0].addedBy).toBe('user-456');
		});

		it('sets purchased to false', () => {
			const result = parseManualItems('milk, eggs', userId);
			for (const item of result) {
				expect(item.purchased).toBe(false);
			}
		});

		it('sets empty recipeIds array', () => {
			const result = parseManualItems('milk, eggs', userId);
			for (const item of result) {
				expect(item.recipeIds).toEqual([]);
			}
		});

		it('returns empty array for empty input', () => {
			const result = parseManualItems('', userId);
			expect(result).toEqual([]);
		});

		it('filters out whitespace-only items', () => {
			const result = parseManualItems('milk, , , eggs', userId);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('milk');
			expect(result[1].name).toBe('eggs');
		});

		it('handles mixed separators', () => {
			const result = parseManualItems('milk, eggs and bread\nchicken', userId);
			expect(result).toHaveLength(4);
			expect(result[0].name).toBe('milk');
			expect(result[1].name).toBe('eggs');
			expect(result[2].name).toBe('bread');
			expect(result[3].name).toBe('chicken');
		});

		it('handles various unit types', () => {
			const cases = [
				{ input: '1 lb chicken', unit: 'lb' },
				{ input: '2 oz cheese', unit: 'oz' },
				{ input: '3 tbsp oil', unit: 'tbsp' },
				{ input: '1 tsp salt', unit: 'tsp' },
				{ input: '1 gallon milk', unit: 'gallon' },
				{ input: '1 dozen eggs', unit: 'dozen' },
				{ input: '2 cans tomatoes', unit: 'cans' },
				{ input: '1 bunch cilantro', unit: 'bunch' },
				{ input: '3 bags chips', unit: 'bags' },
				{ input: '2 boxes pasta', unit: 'boxes' },
				{ input: '2 bottles water', unit: 'bottles' },
				{ input: '1 jar salsa', unit: 'jar' },
			];
			for (const { input, unit } of cases) {
				const result = parseManualItems(input, userId);
				expect(result[0].unit).toBe(unit);
			}
		});

		it('parses quantities with items that have quantity and unit together', () => {
			const result = parseManualItems('2 lbs chicken, 1 cup rice, 3 eggs', userId);
			expect(result).toHaveLength(3);
			expect(result[0]).toMatchObject({ name: 'chicken', quantity: 2, unit: 'lbs' });
			expect(result[1]).toMatchObject({ name: 'rice', quantity: 1, unit: 'cup' });
			expect(result[2]).toMatchObject({ name: 'eggs', quantity: 3, unit: null });
		});

		it('handles "and" as word boundary only', () => {
			// "sand" contains "and" but should not be split
			const result = parseManualItems('sand', userId);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('sand');
		});
	});
});
