/**
 * Q2(b) — "most recent receipt" orders by purchase date, scan time as tiebreak.
 * REQ-FOOD-RECEIPT-005. All dates are relative to now so the tests never rot.
 */

import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices, RouteInfo, ScopedDataStore } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { handleMessage, init } from '../index.js';
import { __clearShadowDepsForTests } from '../routing/shadow-integration.js';
import { findLatestReceipt, loadReceipts } from '../services/receipt-query.js';
import type { Household, Receipt } from '../types.js';

const DAY = 86_400_000;

function daysAgoIso(days: number, hour = 12): string {
	const d = new Date(Date.now() - days * DAY);
	d.setUTCHours(hour, 0, 0, 0);
	return d.toISOString();
}

function daysAgoDate(days: number): string {
	return daysAgoIso(days).slice(0, 10);
}

function makeReceipt(id: string, store: string, date: string, capturedAt: string): Receipt {
	return {
		id,
		store,
		date,
		lineItems: [{ name: `${id}-item`, quantity: 1, unitPrice: 1, totalPrice: 1 }],
		subtotal: 1,
		tax: 0,
		total: 1,
		photoPath: `photos/${id}.b64`,
		capturedAt,
	};
}

function createMemoryStore(initialData: Record<string, string>): ScopedDataStore {
	const files = new Map(Object.entries(initialData));
	return {
		read: vi.fn(async (path: string) => files.get(path) ?? ''),
		write: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
		}),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn(async (path: string) => files.has(path)),
		list: vi.fn(async (directory: string) => {
			const prefix = directory.endsWith('/') ? directory : `${directory}/`;
			return [...files.keys()]
				.filter((path) => path.startsWith(prefix))
				.map((path) => path.slice(prefix.length))
				.filter((path) => path && !path.includes('/'))
				.sort();
		}),
		archive: vi.fn().mockResolvedValue(undefined),
	} as unknown as ScopedDataStore;
}

function storeWith(receipts: Receipt[]): ScopedDataStore {
	const household: Household = {
		id: 'fam1',
		name: 'Test Household',
		createdBy: 'matt',
		members: ['matt'],
		joinCode: 'ABC123',
		createdAt: daysAgoIso(200),
	};
	const files: Record<string, string> = { 'household.yaml': stringify(household) };
	for (const r of receipts) files[`receipts/${r.id}.yaml`] = stringify(r);
	return createMemoryStore(files);
}

describe('loadReceipts ordering (REQ-FOOD-RECEIPT-005)', () => {
	it('older purchase scanned later sorts after newer purchase scanned earlier', async () => {
		// Bought yesterday, scanned yesterday; bought 30 days ago, scanned today.
		const recentPurchase = makeReceipt('recent', 'Costco', daysAgoDate(1), daysAgoIso(1));
		const oldPurchaseScannedToday = makeReceipt('old', 'Costco', daysAgoDate(30), daysAgoIso(0));
		const receipts = await loadReceipts(storeWith([oldPurchaseScannedToday, recentPurchase]));
		expect(receipts.map((r) => r.id)).toEqual(['recent', 'old']);
		expect(findLatestReceipt(receipts)?.id).toBe('recent');
	});

	it('same-day receipts are ordered by capturedAt, newest scan first', async () => {
		const date = daysAgoDate(2);
		const morning = makeReceipt('morning', 'Costco', date, daysAgoIso(2, 8));
		const evening = makeReceipt('evening', 'Costco', date, daysAgoIso(2, 20));
		const receipts = await loadReceipts(storeWith([evening, morning]));
		expect(receipts.map((r) => r.id)).toEqual(['evening', 'morning']);
	});

	it('receipts with an empty or unparseable date sort after every validly dated receipt', async () => {
		const valid = makeReceipt('valid', 'Costco', daysAgoDate(40), daysAgoIso(40));
		const blank = makeReceipt('blank', 'Costco', '', daysAgoIso(0));
		const garbage = makeReceipt('garbage', 'Costco', 'not-a-date', daysAgoIso(0, 13));
		const impossible = makeReceipt('impossible', 'Costco', '2026-02-30', daysAgoIso(0, 14));
		const receipts = await loadReceipts(storeWith([blank, garbage, impossible, valid]));
		expect(receipts[0]?.id).toBe('valid');
		// Undated receipts follow, ordered among themselves by capturedAt (newest first).
		expect(receipts.slice(1).map((r) => r.id)).toEqual(['impossible', 'garbage', 'blank']);
	});

	it('a receipt missing capturedAt sorts after same-day receipts that have one', async () => {
		const date = daysAgoDate(3);
		const withScan = makeReceipt('with-scan', 'Costco', date, daysAgoIso(3));
		const legacy = makeReceipt('legacy', 'Costco', date, daysAgoIso(3));
		(legacy as { capturedAt?: string }).capturedAt = undefined;
		const receipts = await loadReceipts(storeWith([legacy, withScan]));
		expect(receipts.map((r) => r.id)).toEqual(['with-scan', 'legacy']);
	});

	it("findLatestReceipt with a store name returns that store's newest purchase", async () => {
		const newer = makeReceipt('costco-new', 'Costco', daysAgoDate(5), daysAgoIso(5));
		const olderScannedLater = makeReceipt('costco-old', 'Costco', daysAgoDate(45), daysAgoIso(0));
		const other = makeReceipt('tj', 'Trader Joes', daysAgoDate(1), daysAgoIso(1));
		const receipts = await loadReceipts(storeWith([olderScannedLater, newer, other]));
		expect(findLatestReceipt(receipts, 'Costco')?.id).toBe('costco-new');
		expect(findLatestReceipt(receipts)?.id).toBe('tj');
	});
});

describe('food handler "most recent receipt" entry point (REQ-FOOD-RECEIPT-005)', () => {
	const route: RouteInfo = {
		appId: 'food',
		intent: 'user wants to see receipt details or look up items from a receipt',
		confidence: 0.95,
		source: 'intent',
		verifierStatus: 'agreed',
	};
	let services: CoreServices;

	async function setup(receipts: Receipt[]): Promise<void> {
		const sharedStore = storeWith(receipts);
		services = createMockCoreServices({
			data: {
				forShared: vi.fn().mockReturnValue(sharedStore),
				forUser: vi.fn().mockReturnValue(sharedStore),
				forSpace: vi.fn().mockReturnValue(sharedStore),
			},
			interactionContext: { getRecent: vi.fn().mockReturnValue([]) },
			config: {
				get: vi.fn(async (key: string) => {
					if (key === 'shadow_sample_rate') return 0;
					if (key === 'routing_primary') return 'regex';
					return undefined;
				}),
			},
		});
		await init(services);
		__clearShadowDepsForTests();
	}

	beforeEach(() => {
		__clearShadowDepsForTests();
	});

	it('answers with the newest purchase, not the most recently scanned one', async () => {
		await setup([
			makeReceipt('bought-yesterday', 'Costco', daysAgoDate(1), daysAgoIso(1)),
			makeReceipt('bought-last-month', 'Trader Joes', daysAgoDate(30), daysAgoIso(0)),
		]);
		await handleMessage(
			createTestMessageContext({ userId: 'matt', text: 'show me my last receipt', route }),
		);
		expect(services.telegram.send).toHaveBeenCalledWith(
			'matt',
			expect.stringContaining('Costco receipt'),
		);
		expect(services.telegram.send).not.toHaveBeenCalledWith(
			'matt',
			expect.stringContaining('Trader Joes receipt'),
		);
	});

	it('store-specific query ("last trip to Costco") also uses purchase date', async () => {
		await setup([
			makeReceipt('costco-new', 'Costco', daysAgoDate(4), daysAgoIso(4)),
			makeReceipt('costco-old', 'Costco', daysAgoDate(50), daysAgoIso(0)),
		]);
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'what was on my last trip to Costco',
				route,
			}),
		);
		const sent = vi
			.mocked(services.telegram.send)
			.mock.calls.map((c) => String(c[1]))
			.join('\n');
		expect(sent).toContain(`Costco receipt (${daysAgoDate(4)})`);
		expect(sent).not.toContain(daysAgoDate(50));
	});
});
