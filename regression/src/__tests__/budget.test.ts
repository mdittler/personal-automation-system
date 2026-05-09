import { describe, expect, it } from 'vitest';
import { CaseBudget, RunBudget } from '../runner/budget.js';

describe('CaseBudget', () => {
	it('allows spend up to ceiling', () => {
		const b = new CaseBudget(0.05);
		b.charge(0.02);
		b.charge(0.02);
		expect(b.totalUsd).toBeCloseTo(0.04, 4);
		expect(b.exceeded).toBe(false);
	});

	it('flags exceeded once ceiling is crossed', () => {
		const b = new CaseBudget(0.05);
		b.charge(0.06);
		expect(b.exceeded).toBe(true);
	});

	it('throws if charge is negative', () => {
		const b = new CaseBudget(0.05);
		expect(() => b.charge(-0.01)).toThrow(/negative/i);
	});

	it('throws if charge is NaN or Infinity (LLM-output untrust)', () => {
		const b = new CaseBudget(0.05);
		expect(() => b.charge(Number.NaN)).toThrow(/finite/i);
		expect(() => b.charge(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
	});

	it('rejects ceiling configured as <= 0', () => {
		expect(() => new CaseBudget(0)).toThrow(/positive/i);
		expect(() => new CaseBudget(-1)).toThrow(/positive/i);
	});
});

describe('RunBudget', () => {
	it('aggregates across cases', () => {
		const b = new RunBudget(5.0);
		b.add(1.5);
		b.add(2.5);
		expect(b.totalUsd).toBeCloseTo(4.0, 4);
		expect(b.remainingUsd).toBeCloseTo(1.0, 4);
	});

	it('flags exceeded when sum crosses ceiling', () => {
		const b = new RunBudget(5.0);
		b.add(3);
		b.add(3);
		expect(b.exceeded).toBe(true);
	});

	it('canAfford returns false when next charge would cross ceiling', () => {
		const b = new RunBudget(5.0);
		b.add(4.5);
		expect(b.canAfford(0.4)).toBe(true);
		expect(b.canAfford(0.6)).toBe(false);
	});
});
