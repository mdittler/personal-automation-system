/**
 * Ground truth derived from the agent seed fixture (REQ-REG-AGENT-003).
 * Task expectations read numbers from here so they cannot drift from the
 * generated receipts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

export interface SeedLineItem {
	name: string;
	quantity: number;
	unitPrice: number;
	totalPrice: number;
}

export interface SeedReceipt {
	id: string;
	store: string;
	date: string;
	subtotal: number;
	tax: number;
	total: number;
	lineItems: SeedLineItem[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function loadSeedReceipts(fixturesDir: string): SeedReceipt[] {
	const dir = join(fixturesDir, 'household', 'food', 'receipts');
	return readdirSync(dir)
		.filter((f) => f.endsWith('.yaml'))
		.sort()
		.map((f) => {
			const raw = readFileSync(join(dir, f), 'utf8');
			const r = YAML.parse(raw.replace(/^---\n[\s\S]*?\n---\n/, '')) as Record<string, unknown>;
			return {
				id: String(r.id),
				store: String(r.store),
				date: String(r.date),
				subtotal: Number(r.subtotal),
				tax: Number(r.tax),
				total: Number(r.total),
				lineItems: r.lineItems as SeedLineItem[],
			};
		});
}

export function seedFacts(fixturesDir: string) {
	const receipts = loadSeedReceipts(fixturesDir);
	const byStore = (store: string): SeedReceipt[] =>
		receipts.filter((r) => r.store === store).sort((a, b) => a.date.localeCompare(b.date));
	const sum = (rs: SeedReceipt[], pick: (r: SeedReceipt) => number): number =>
		round2(rs.reduce((a, r) => a + pick(r), 0));
	const at = (store: string, fromEnd: number): SeedReceipt => {
		const rs = byStore(store);
		const r = rs[rs.length - fromEnd];
		if (!r) throw new Error(`seed facts: ${store} has fewer than ${fromEnd} receipts`);
		return r;
	};
	return {
		receipts,
		latest: (store: string) => at(store, 1),
		previous: (store: string) => at(store, 2),
		trips: (store: string) => byStore(store).length,
		storeTotal: (store: string) => sum(byStore(store), (r) => r.total),
		storeTax: (store: string) => sum(byStore(store), (r) => r.tax),
		storeAverage: (store: string) =>
			round2(sum(byStore(store), (r) => r.total) / byStore(store).length),
		totalBetween: (from: string, to?: string) =>
			sum(
				receipts.filter((r) => r.date >= from && (to === undefined || r.date <= to)),
				(r) => r.total,
			),
		storeTotalBetween: (store: string, from: string, to: string) =>
			sum(
				byStore(store).filter((r) => r.date >= from && r.date <= to),
				(r) => r.total,
			),
		mostItems: (store: string) =>
			byStore(store).reduce((best, r) => (r.lineItems.length > best.lineItems.length ? r : best)),
		quantityOf: (re: RegExp) =>
			receipts
				.flatMap((r) => r.lineItems)
				.filter((i) => re.test(i.name))
				.reduce((a, i) => a + i.quantity, 0),
		maxUnitPrice: () =>
			receipts
				.flatMap((r) => r.lineItems)
				.reduce((best, i) => (i.unitPrice > best.unitPrice ? i : best)),
	};
}
