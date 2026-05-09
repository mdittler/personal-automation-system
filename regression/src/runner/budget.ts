/** REQ-REG-008 — per-case budget. REQ-REG-009 — per-run ceiling. */

function assertFinitePositive(n: number, fieldName: string): void {
	if (!Number.isFinite(n)) throw new Error(`${fieldName} must be finite (was ${n})`);
	if (n <= 0) throw new Error(`${fieldName} must be positive (was ${n})`);
}

function assertFiniteNonNeg(n: number, fieldName: string): void {
	if (!Number.isFinite(n)) throw new Error(`${fieldName} must be finite (was ${n})`);
	if (n < 0) throw new Error(`${fieldName} must not be negative (was ${n})`);
}

export class CaseBudget {
	totalUsd = 0;
	constructor(public readonly ceilingUsd: number) {
		assertFinitePositive(ceilingUsd, 'ceilingUsd');
	}
	charge(amount: number): void {
		assertFiniteNonNeg(amount, 'charge amount');
		this.totalUsd += amount;
	}
	get exceeded(): boolean {
		return this.totalUsd > this.ceilingUsd;
	}
}

export class RunBudget {
	totalUsd = 0;
	constructor(public readonly ceilingUsd: number) {
		assertFinitePositive(ceilingUsd, 'ceilingUsd');
	}
	add(amount: number): void {
		assertFiniteNonNeg(amount, 'amount');
		this.totalUsd += amount;
	}
	get remainingUsd(): number {
		return Math.max(0, this.ceilingUsd - this.totalUsd);
	}
	get exceeded(): boolean {
		return this.totalUsd > this.ceilingUsd;
	}
	canAfford(amount: number): boolean {
		assertFiniteNonNeg(amount, 'amount');
		return this.totalUsd + amount <= this.ceilingUsd;
	}
}
