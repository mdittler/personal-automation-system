import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices, RouteInfo, ScopedDataStore } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { handleMessage, init } from '../index.js';
import { __clearShadowDepsForTests } from '../routing/shadow-integration.js';
import type { Household, Receipt } from '../types.js';

const household: Household = {
	id: 'fam1',
	name: 'Matt Household',
	createdBy: 'matt',
	members: ['matt'],
	joinCode: 'ABC123',
	createdAt: '2026-01-01T00:00:00.000Z',
};

const costcoReceipt: Receipt = {
	id: '2026-05-04-test',
	store: 'Costco',
	date: '2026-05-04',
	lineItems: [
		{ name: 'Spindrift', quantity: 1, unitPrice: 19.69, totalPrice: 19.69 },
		{ name: 'Q-Tips', quantity: 1, unitPrice: 9.99, totalPrice: 9.99 },
		{ name: 'Hug PU 3T-4T', quantity: 1, unitPrice: 39.99, totalPrice: 39.99 },
		{ name: 'KS Blueberry', quantity: 1, unitPrice: 9.29, totalPrice: 9.29 },
		{ name: 'Blueberries', quantity: 1, unitPrice: 7.69, totalPrice: 7.69 },
	],
	subtotal: 86.65,
	tax: 13.08,
	total: 99.73,
	photoPath: 'photos/receipt-test.b64',
	capturedAt: '2026-05-04T19:33:06.069Z',
	priceUpdates: [
		{
			receiptName: 'Spindrift',
			normalizedName: 'Spindrift Sparkling Water',
			price: 19.69,
			status: 'updated',
			department: 'Beverages',
			unit: '',
			updatedAt: '2026-05-04',
		},
		{
			receiptName: 'Blueberries',
			normalizedName: 'Blueberries',
			price: 7.69,
			status: 'added',
			department: 'Produce',
			unit: '',
			updatedAt: '2026-05-04',
		},
	],
};

const traderJoesReceipt: Receipt = {
	id: '2026-04-29-tj-test',
	store: 'Trader Joes',
	date: '2026-04-29',
	lineItems: [
		{ name: 'Ground Beef', quantity: 1, unitPrice: 8.99, totalPrice: 8.99 },
		{ name: 'Tomatoes On The Vine', quantity: 1, unitPrice: 2.99, totalPrice: 2.99 },
	],
	subtotal: 11.98,
	tax: 0,
	total: 11.98,
	photoPath: 'photos/receipt-tj.b64',
	capturedAt: '2026-04-29T18:10:00.000Z',
};

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

function makeRoute(intent: string): RouteInfo {
	return {
		appId: 'food',
		intent,
		confidence: 0.95,
		source: 'intent',
		verifierStatus: 'agreed',
	};
}

describe('Food receipt prompt loop', () => {
	let services: CoreServices;

	beforeEach(async () => {
		const sharedStore = createMemoryStore({
			'household.yaml': stringify(household),
			'receipts/2026-05-04-test.yaml': stringify(costcoReceipt),
			'receipts/2026-04-29-tj-test.yaml': stringify(traderJoesReceipt),
			'prices/costco.md': [
				'---',
				'store: Costco',
				'slug: costco',
				'last_updated: 2026-05-04',
				'type: price-list',
				'entity_keys:',
				'  - costco',
				'---',
				'',
				'## Produce',
				'- Blueberries: $7.69 <!-- updated: 2026-05-04 -->',
				'- Organic Blueberry: $9.29 <!-- updated: 2026-05-04 -->',
			].join('\n'),
			'prices/trader-joes.md': [
				'---',
				'store: Trader Joes',
				'slug: trader-joes',
				'last_updated: 2026-05-04',
				'type: price-list',
				'entity_keys:',
				'  - trader joes',
				'---',
				'',
				'## Produce',
				'- Blueberries: $6.49 <!-- updated: 2026-05-04 -->',
			].join('\n'),
		});
		services = createMockCoreServices({
			data: {
				forShared: vi.fn().mockReturnValue(sharedStore),
				forUser: vi.fn().mockReturnValue(sharedStore),
				forSpace: vi.fn().mockReturnValue(sharedStore),
			},
			interactionContext: {
				getRecent: vi.fn().mockReturnValue([
					{
						appId: 'food',
						action: 'receipt_captured',
						entityType: 'receipt',
						scope: 'shared',
						timestamp: Date.now(),
						filePaths: ['users/shared/food/receipts/2026-05-04-test.yaml'],
					},
				]),
			},
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
	});

	it('answers a follow-up asking for receipt item prices instead of falling through to help', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'Can you break out the price of each item and indicate what is new?',
			}),
		);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'matt',
			expect.stringContaining('Blueberries'),
		);
		expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('$7.69'));
		expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('new'));
		expect(services.telegram.send).not.toHaveBeenCalledWith(
			'matt',
			expect.stringContaining("I'm not sure what you'd like to do"),
		);
	});

	it('answers direct store item price questions from the price store', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'How much are blueberries at Costco?',
			}),
		);

		expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Costco'));
		expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('$7.69'));
		expect(services.telegram.send).not.toHaveBeenCalledWith(
			'matt',
			expect.stringContaining("I'm not sure what you'd like to do"),
		);
	});

	// Helper: find the send call that contains the cheapest-price response
	// (matches both unit-price and package-price wording).
	function findCheapestReply(): string | undefined {
		const call = vi
			.mocked(services.telegram.send)
			.mock.calls.find(
				([userId, text]) =>
					userId === 'matt' &&
					typeof text === 'string' &&
					((text as string).includes('Lowest saved package price') ||
						(text as string).includes('Lowest saved unit price')),
			);
		return call?.[1] as string | undefined;
	}

	// Helper: assert the standard REQ-FOOD-PRICE-002 expectations on a cheapest-reply string
	function assertCheapestBlueberryReply(sent: string | undefined): void {
		expect(sent).toBeDefined();
		expect(sent).toContain('Lowest saved package price for blueberr');
		expect(sent).toContain('Trader Joes');
		expect(sent).toContain('$6.49');
		expect(sent).not.toContain('is cheapest for');
	}

	// P1 — existing phrasing: "cheapest spot to buy X" → cheapest branch (explicit cheapest keyword)
	it('compares stores for cheapest item price questions', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'Can you tell me the cheapest spot to buy blueberries?',
			}),
		);

		const sent = findCheapestReply();
		assertCheapestBlueberryReply(sent);
		expect(sent).not.toContain('\n');
	});

	// P2 — alternate phrasing with explicit "cheapest ... buy" → cheapest branch (REQ-FOOD-PRICE-002)
	it('cheapest price: "What\'s the cheapest place to buy blueberries?" (P2)', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: "What's the cheapest place to buy blueberries?",
			}),
		);

		assertCheapestBlueberryReply(findCheapestReply());
	});

	// P3 — "How much are X?" phrasing → no cheapest keyword, no store → fallthrough to formatCheapestPriceAnswer (REQ-FOOD-PRICE-002)
	it('cheapest price fallthrough: "How much are blueberries?" (P3)', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'How much are blueberries?',
			}),
		);

		assertCheapestBlueberryReply(findCheapestReply());
	});

	// P4 — "Price for X?" phrasing → no cheapest keyword, no store → fallthrough to formatCheapestPriceAnswer (REQ-FOOD-PRICE-002)
	it('cheapest price fallthrough: "Price for blueberries?" (P4)', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'Price for blueberries?',
			}),
		);

		assertCheapestBlueberryReply(findCheapestReply());
	});

	it('answers grocery-store spending questions from receipt history instead of meal-plan budget', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'How much do I typically spend at each grocery store?',
			}),
		);

		expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Costco'));
		expect(services.telegram.send).toHaveBeenCalledWith(
			'matt',
			expect.stringContaining('Trader Joes'),
		);
		expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('$99.73'));
		expect(services.telegram.send).not.toHaveBeenCalledWith(
			'matt',
			expect.stringContaining('meal plan'),
		);
	});

	it('answers receipt detail questions when the core route selects the receipt intent', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'Can you send me those items and the total?',
				route: makeRoute('user wants to see receipt details or look up items from a receipt'),
			}),
		);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'matt',
			expect.stringContaining('Costco receipt'),
		);
		expect(services.telegram.send).toHaveBeenCalledWith(
			'matt',
			expect.stringContaining('Total: $99.73'),
		);
	});

	it('answers price lookups when the core route selects the store-prices intent', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'How much are blueberries at Costco?',
				route: makeRoute('user asks about prices at a specific store'),
			}),
		);

		expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('$7.69'));
	});

	it('answers store spending when the core route selects the food-spending intent', async () => {
		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'How much do I typically spend at each grocery store?',
				route: makeRoute('user wants to see food spending'),
			}),
		);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'matt',
			expect.stringContaining('Grocery spending by store'),
		);
		expect(services.telegram.send).not.toHaveBeenCalledWith(
			'matt',
			expect.stringContaining('meal plan'),
		);
	});
});

// ---------------------------------------------------------------------------
// REQ-FOOD-PRICE-003 — Unit-price comparison persona tests (P5/P6)
// ---------------------------------------------------------------------------

describe('Food cheapest-price unit normalization (REQ-FOOD-PRICE-003)', () => {
	let services: CoreServices;

	async function bootServices(sharedStore: ReturnType<typeof createMemoryStore>): Promise<void> {
		services = createMockCoreServices({
			data: {
				forShared: vi.fn().mockReturnValue(sharedStore),
				forUser: vi.fn().mockReturnValue(sharedStore),
				forSpace: vi.fn().mockReturnValue(sharedStore),
			},
			interactionContext: {
				getRecent: vi.fn().mockReturnValue([]),
			},
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

	function findReplyContaining(snippet: string): string | undefined {
		const call = vi
			.mocked(services.telegram.send)
			.mock.calls.find(
				([userId, text]) =>
					userId === 'matt' && typeof text === 'string' && (text as string).includes(snippet),
			);
		return call?.[1] as string | undefined;
	}

	function findUnitOrPackageReply(): string | undefined {
		const call = vi
			.mocked(services.telegram.send)
			.mock.calls.find(
				([userId, text]) =>
					userId === 'matt' &&
					typeof text === 'string' &&
					((text as string).includes('Lowest saved unit price') ||
						(text as string).includes('Lowest saved package price')),
			);
		return call?.[1] as string | undefined;
	}

	// Phrasings — Package A (smaller) has lower package price; Package B (larger) has lower unit price.
	// All phrasings are chosen to flow through the existing routing pipeline
	// (PRICE_LOOKUP_RE + extractPriceItem) so the cheapest-price branch is reached.
	const P5_PHRASINGS: Array<{ label: string; text: string; item: string }> = [
		{ label: 'P5.1', text: 'cheapest spot to buy milk', item: 'milk' },
		{ label: 'P5.2', text: 'price for flour', item: 'flour' },
		{ label: 'P5.3', text: 'what is the price of rice', item: 'rice' },
		{ label: 'P5.4', text: 'where do i get the best price for sugar', item: 'sugar' },
		{ label: 'P5.5', text: 'cost of pasta', item: 'pasta' },
	];

	for (const { label, text, item } of P5_PHRASINGS) {
		it(`${label}: "${text}" — unit-price wins, output contains /100g and Costco`, async () => {
			// Smaller @ TJ: 6 oz @ $4.99 = ~$2.93/100g
			// Larger @ Costco: 12 oz @ $7.99 = ~$2.35/100g — winner per unit
			// We name the entries so the query 'item' loosely matches 'pack' tokens via tokenizeItem.
			// Use items based on the phrasing word.
			const tjUnit = '6 oz';
			const costcoUnit = '12 oz';
			const sharedStore = createMemoryStore({
				'household.yaml': stringify(household),
				'prices/trader-joes.md': [
					'---',
					'store: Trader Joes',
					'slug: trader-joes',
					'last_updated: 2026-05-04',
					'type: price-list',
					'entity_keys:',
					'  - trader joes',
					'---',
					'',
					'## Pantry',
					`- ${item} pack A (${tjUnit}): $4.99 <!-- updated: 2026-05-04 -->`,
				].join('\n'),
				'prices/costco.md': [
					'---',
					'store: Costco',
					'slug: costco',
					'last_updated: 2026-05-04',
					'type: price-list',
					'entity_keys:',
					'  - costco',
					'---',
					'',
					'## Pantry',
					`- ${item} pack B (${costcoUnit}): $7.99 <!-- updated: 2026-05-04 -->`,
				].join('\n'),
			});
			await bootServices(sharedStore);

			await handleMessage(
				createTestMessageContext({
					userId: 'matt',
					text,
				}),
			);

			const sent = findUnitOrPackageReply();
			expect(sent).toBeDefined();
			expect(sent).toContain('Lowest saved unit price');
			expect(sent).toContain('Costco');
			expect(sent).toContain('/100g');
			expect(sent).not.toContain('Lowest saved package price');
		});
	}

	// P6 — package-mode fallback: mixed-base entries.
	const P6_PHRASINGS: Array<{ label: string; text: string; item: string }> = [
		{ label: 'P6.1', text: 'cheapest spot to buy milk', item: 'milk' },
		{ label: 'P6.2', text: 'price for pasta', item: 'pasta' },
		{ label: 'P6.3', text: 'best price for coffee', item: 'coffee' },
	];

	for (const { label, text, item } of P6_PHRASINGS) {
		it(`${label}: "${text}" — mixed bases fall back to package-price`, async () => {
			const sharedStore = createMemoryStore({
				'household.yaml': stringify(household),
				'prices/trader-joes.md': [
					'---',
					'store: Trader Joes',
					'slug: trader-joes',
					'last_updated: 2026-05-04',
					'type: price-list',
					'entity_keys:',
					'  - trader joes',
					'---',
					'',
					'## Pantry',
					`- ${item} pack A (12 oz): $4.99 <!-- updated: 2026-05-04 -->`,
				].join('\n'),
				'prices/costco.md': [
					'---',
					'store: Costco',
					'slug: costco',
					'last_updated: 2026-05-04',
					'type: price-list',
					'entity_keys:',
					'  - costco',
					'---',
					'',
					'## Pantry',
					`- ${item} pack B (1 L): $7.99 <!-- updated: 2026-05-04 -->`,
				].join('\n'),
			});
			await bootServices(sharedStore);

			await handleMessage(
				createTestMessageContext({
					userId: 'matt',
					text,
				}),
			);

			const sent = findUnitOrPackageReply();
			expect(sent).toBeDefined();
			expect(sent).toContain('Lowest saved package price');
			expect(sent).not.toContain('/100g');
			expect(sent).not.toContain('/100ml');
		});
	}

	// Negative — should NOT match price-lookup intent.
	it('does NOT trigger price-lookup for "the milk in the fridge expired"', async () => {
		const sharedStore = createMemoryStore({
			'household.yaml': stringify(household),
			'prices/trader-joes.md': [
				'---',
				'store: Trader Joes',
				'slug: trader-joes',
				'last_updated: 2026-05-04',
				'---',
				'',
				'## Dairy',
				'- Milk (1 gal): $3.99 <!-- updated: 2026-05-04 -->',
			].join('\n'),
		});
		await bootServices(sharedStore);

		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'the milk in the fridge expired',
			}),
		);

		// Must NOT route to cheapest-price reply.
		expect(findReplyContaining('Lowest saved unit price')).toBeUndefined();
		expect(findReplyContaining('Lowest saved package price')).toBeUndefined();
	});

	// Negative — "cheapest milk receipt" should not yield a cheapest-price reply
	// (either it's a receipt-query intent or it doesn't match price-lookup at all
	// because PRICE_LOOKUP_EXCLUDE_RE includes "receipt").
	it('does NOT route "cheapest milk receipt" to cheapest-price branch', async () => {
		const sharedStore = createMemoryStore({
			'household.yaml': stringify(household),
			'prices/trader-joes.md': [
				'---',
				'store: Trader Joes',
				'slug: trader-joes',
				'last_updated: 2026-05-04',
				'---',
				'',
				'## Dairy',
				'- Milk (1 gal): $3.99 <!-- updated: 2026-05-04 -->',
			].join('\n'),
		});
		await bootServices(sharedStore);

		await handleMessage(
			createTestMessageContext({
				userId: 'matt',
				text: 'cheapest milk receipt',
			}),
		);

		expect(findReplyContaining('Lowest saved unit price')).toBeUndefined();
		expect(findReplyContaining('Lowest saved package price')).toBeUndefined();
	});
});
