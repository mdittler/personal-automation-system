import { describe, expect, it } from 'vitest';
import { updateLastFiredInContent } from '../index.js';

describe('updateLastFiredInContent', () => {
	it('updates an existing Last fired line', () => {
		const content = [
			'## check-stock',
			'- **Condition:** not empty',
			'- **Data:** `stock.md`',
			'- **Action:** Send alert',
			'- **Cooldown:** 24 hours',
			'- **Last fired:** 2026-02-25T10:00:00.000Z',
		].join('\n');

		const result = updateLastFiredInContent(
			content,
			'check-stock',
			false,
			new Date('2026-02-27T15:30:00.000Z'),
		);

		expect(result).toContain('- **Last fired:** 2026-02-27T15:30:00.000Z');
		expect(result).not.toContain('2026-02-25T10:00:00.000Z');
	});

	it('inserts Last fired line when missing', () => {
		const content = [
			'## check-stock',
			'- **Condition:** not empty',
			'- **Data:** `stock.md`',
			'- **Action:** Send alert',
			'- **Cooldown:** 24 hours',
		].join('\n');

		const result = updateLastFiredInContent(
			content,
			'check-stock',
			false,
			new Date('2026-02-27T15:30:00.000Z'),
		);

		expect(result).toContain('- **Last fired:** 2026-02-27T15:30:00.000Z');
	});

	it('handles fuzzy rule IDs', () => {
		const content = [
			'## fuzzy:low-stock',
			'- **Condition:** stock levels seem low',
			'- **Data:** `stock.md`',
			'- **Action:** Send alert',
			'- **Cooldown:** 48 hours',
			'- **Last fired:** never',
		].join('\n');

		const result = updateLastFiredInContent(
			content,
			'low-stock',
			true,
			new Date('2026-02-27T12:00:00.000Z'),
		);

		expect(result).toContain('- **Last fired:** 2026-02-27T12:00:00.000Z');
	});

	it('only updates the target rule in a multi-rule file', () => {
		const content = [
			'## rule-a',
			'- **Condition:** not empty',
			'- **Data:** `a.md`',
			'- **Action:** Alert A',
			'- **Cooldown:** 24 hours',
			'- **Last fired:** 2026-02-20T00:00:00.000Z',
			'',
			'## rule-b',
			'- **Condition:** is empty',
			'- **Data:** `b.md`',
			'- **Action:** Alert B',
			'- **Cooldown:** 48 hours',
			'- **Last fired:** 2026-02-21T00:00:00.000Z',
		].join('\n');

		const result = updateLastFiredInContent(
			content,
			'rule-b',
			false,
			new Date('2026-02-27T18:00:00.000Z'),
		);

		// rule-a unchanged
		expect(result).toContain('- **Last fired:** 2026-02-20T00:00:00.000Z');
		// rule-b updated
		expect(result).toContain('- **Last fired:** 2026-02-27T18:00:00.000Z');
		// original rule-b timestamp gone
		expect(result).not.toContain('2026-02-21T00:00:00.000Z');
	});

	it('does not modify content when rule ID is not found', () => {
		const content = [
			'## other-rule',
			'- **Condition:** not empty',
			'- **Cooldown:** 24 hours',
		].join('\n');

		const result = updateLastFiredInContent(
			content,
			'missing-rule',
			false,
			new Date('2026-02-27T12:00:00.000Z'),
		);

		expect(result).toBe(content);
	});
});
