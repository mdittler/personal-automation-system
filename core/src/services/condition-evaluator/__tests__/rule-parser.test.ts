import { describe, expect, it } from 'vitest';
import { parseRuleFile } from '../rule-parser.js';

const sampleRuleFile = `
## low-grocery-items
- **Condition:** line count < 3
- **Data:** \`grocery/list.md\`
- **Action:** Send Telegram message: "Your grocery list is getting low!"
- **Cooldown:** 48 hours
- **Last fired:** 2026-02-25T18:00:00Z

## fuzzy:stale-meal-plan
- **Condition:** The meal plan has not been updated in over a week
- **Data:** \`grocery/meal-plans/current.md\`
- **Action:** Send Telegram message: "Your meal plan might be stale. Want to generate a new one?"
- **Cooldown:** 7 days
- **Last fired:** never
`;

describe('parseRuleFile', () => {
	it('parses multiple rules from a file', () => {
		const rules = parseRuleFile(sampleRuleFile);
		expect(rules).toHaveLength(2);
	});

	it('parses a deterministic rule correctly', () => {
		const rules = parseRuleFile(sampleRuleFile);
		const rule = rules[0];

		expect(rule?.id).toBe('low-grocery-items');
		expect(rule?.isFuzzy).toBe(false);
		expect(rule?.condition).toBe('line count < 3');
		expect(rule?.dataSources).toEqual(['grocery/list.md']);
		expect(rule?.action).toContain('grocery list is getting low');
		expect(rule?.cooldown).toBe('48 hours');
		expect(rule?.cooldownMs).toBe(48 * 60 * 60 * 1000);
		expect(rule?.lastFired).toBeInstanceOf(Date);
		expect(rule?.lastFired?.toISOString()).toBe('2026-02-25T18:00:00.000Z');
	});

	it('parses a fuzzy rule correctly', () => {
		const rules = parseRuleFile(sampleRuleFile);
		const rule = rules[1];

		expect(rule?.id).toBe('stale-meal-plan');
		expect(rule?.isFuzzy).toBe(true);
		expect(rule?.condition).toContain('not been updated');
		expect(rule?.dataSources).toEqual(['grocery/meal-plans/current.md']);
		expect(rule?.cooldown).toBe('7 days');
		expect(rule?.cooldownMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(rule?.lastFired).toBeNull();
	});

	it('handles multiple data sources', () => {
		const content = `
## multi-data-rule
- **Condition:** not empty
- **Data:** \`path/a.md\`, \`path/b.md\`
- **Action:** Alert
- **Cooldown:** 1 hour
`;
		const rules = parseRuleFile(content);
		expect(rules[0]?.dataSources).toEqual(['path/a.md', 'path/b.md']);
	});

	it('provides defaults for missing optional fields', () => {
		const content = `
## minimal-rule
- **Condition:** is not empty
- **Data:** \`some/data.md\`
`;
		const rules = parseRuleFile(content);
		expect(rules[0]?.id).toBe('minimal-rule');
		expect(rules[0]?.action).toBe('');
		expect(rules[0]?.cooldown).toBe('24 hours');
		expect(rules[0]?.cooldownMs).toBe(24 * 60 * 60 * 1000);
		expect(rules[0]?.lastFired).toBeNull();
		expect(rules[0]?.isFuzzy).toBe(false);
	});

	it('skips rules without a condition', () => {
		const content = `
## incomplete-rule
- **Data:** \`data.md\`
- **Action:** Alert
`;
		const rules = parseRuleFile(content);
		expect(rules).toHaveLength(0);
	});

	it('returns empty array for empty content', () => {
		expect(parseRuleFile('')).toEqual([]);
		expect(parseRuleFile('# Just a title\nSome text')).toEqual([]);
	});
});
