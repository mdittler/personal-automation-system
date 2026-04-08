/**
 * Price store — per-store price database CRUD.
 *
 * Manages Obsidian-compatible .md files in shared/prices/.
 * Each store has its own file (e.g., prices/costco.md) with items
 * organized by department.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter } from '@pas/core/utils/frontmatter';
import type { PriceEntry, Receipt, StorePriceData } from '../types.js';
import { sanitizeInput } from '../utils/sanitize.js';

const PRICES_DIR = 'prices';

/** Convert a store display name to a file-safe slug. */
export function getStoreSlug(storeName: string): string {
	return storeName
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/** Format a StorePriceData as an Obsidian-compatible markdown file. */
export function formatPriceFile(data: StorePriceData): string {
	const fm = generateFrontmatter({
		store: data.store,
		slug: data.slug,
		last_updated: data.lastUpdated,
		item_count: data.items.length,
		tags: buildAppTags('hearthstone', 'prices'),
		app: 'hearthstone',
	});

	const byDept = new Map<string, PriceEntry[]>();
	for (const item of data.items) {
		const dept = item.department || 'Other';
		const existing = byDept.get(dept) ?? [];
		existing.push(item);
		byDept.set(dept, existing);
	}

	const lines: string[] = [];
	for (const [dept, items] of byDept) {
		lines.push(`## ${dept}`);
		for (const item of items) {
			lines.push(`- ${item.name}: $${item.price.toFixed(2)} <!-- updated: ${item.updatedAt} -->`);
		}
		lines.push('');
	}

	return fm + '\n' + lines.join('\n');
}

const PRICE_LINE_RE = /^- (.+?):\s*\$(\d+(?:\.\d+)?)\s*(?:<!--\s*updated:\s*(\d{4}-\d{2}-\d{2})\s*-->)?$/;

function extractUnit(name: string): string {
	const match = name.match(/\(([^)]+)\)\s*$/);
	return match?.[1] ?? '';
}

export function parsePriceFile(raw: string, slug: string): StorePriceData {
	if (!raw.trim()) {
		return { store: slug, slug, lastUpdated: '', items: [] };
	}

	let store = slug;
	let lastUpdated = '';
	const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
	if (fmMatch) {
		const fmBlock = fmMatch[1] ?? '';
		const storeMatch = fmBlock.match(/^store:\s*(.+)$/m);
		if (storeMatch) store = storeMatch[1]!.trim();
		const dateMatch = fmBlock.match(/^last_updated:\s*"?(\d{4}-\d{2}-\d{2})"?$/m);
		if (dateMatch) lastUpdated = dateMatch[1]!;
	}

	const items: PriceEntry[] = [];
	let currentDept = 'Other';

	for (const line of raw.split('\n')) {
		const deptMatch = line.match(/^##\s+(.+)$/);
		if (deptMatch) {
			currentDept = deptMatch[1]!.trim();
			continue;
		}

		const priceMatch = line.match(PRICE_LINE_RE);
		if (priceMatch) {
			const name = priceMatch[1]!.trim();
			items.push({
				name,
				price: Number.parseFloat(priceMatch[2]!),
				unit: extractUnit(name),
				department: currentDept,
				updatedAt: priceMatch[3] ?? lastUpdated,
			});
		}
	}

	return { store, slug, lastUpdated, items };
}

export async function loadStorePrices(store: ScopedDataStore, storeSlug: string): Promise<StorePriceData> {
	const raw = await store.read(`${PRICES_DIR}/${storeSlug}.md`);
	if (!raw) return { store: storeSlug, slug: storeSlug, lastUpdated: '', items: [] };
	return parsePriceFile(raw, storeSlug);
}

export async function saveStorePrices(store: ScopedDataStore, data: StorePriceData): Promise<void> {
	const content = formatPriceFile(data);
	await store.write(`${PRICES_DIR}/${data.slug}.md`, content);
}

export function addOrUpdatePrice(data: StorePriceData, entry: PriceEntry): StorePriceData {
	const lowerName = entry.name.toLowerCase();
	const idx = data.items.findIndex((i) => i.name.toLowerCase() === lowerName);

	const items = [...data.items];
	if (idx >= 0) {
		items[idx] = { ...entry, name: items[idx]!.name };
	} else {
		items.push(entry);
	}

	return { ...data, items, lastUpdated: entry.updatedAt };
}

export function lookupPrice(items: PriceEntry[], name: string): PriceEntry | null {
	const lower = name.toLowerCase();
	return items.find((i) => i.name.toLowerCase() === lower) ?? null;
}

export async function listStores(store: ScopedDataStore): Promise<string[]> {
	const files = await store.list(PRICES_DIR);
	return files
		.filter((f) => f.endsWith('.md'))
		.map((f) => f.replace(/\.md$/, ''));
}

// ─── Task 3: Receipt Auto-Update ─────────────────────────────────────────────

interface NormalizedItem {
	receiptName: string;
	normalizedName: string;
	department: string;
	unit: string;
}

const NORMALIZE_PROMPT = `You are a grocery item normalizer. Given receipt line items, normalize each name to a clean, readable format with package size in parentheses.

Return ONLY a JSON array with this structure (no markdown, no explanation):
[
  { "receiptName": "KS ORG EGGS 5DZ", "normalizedName": "Eggs (60ct)", "department": "Dairy", "unit": "60ct" }
]

Department must be one of: Dairy, Produce, Meat, Seafood, Bakery, Pantry, Frozen, Beverages, Snacks, Other

Rules:
- Normalize abbreviations to full words
- Include package size/quantity in parentheses
- Use title case for item names
- department should be the grocery department
- unit is the package size (e.g., "60ct", "1 gal", "5 lb")`;

export interface ReceiptUpdateResult {
	updatedCount: number;
	addedCount: number;
	error?: string;
}

export async function updatePricesFromReceipt(
	services: CoreServices,
	store: ScopedDataStore,
	receipt: Receipt,
): Promise<ReceiptUpdateResult> {
	const validItems = receipt.lineItems.filter((li) => li.totalPrice > 0);
	if (validItems.length === 0) return { updatedCount: 0, addedCount: 0 };

	const slug = getStoreSlug(receipt.store);

	let normalized: NormalizedItem[];
	try {
		const itemList = validItems.map((li) => `"${sanitizeInput(li.name, 100)}"`).join(', ');
		const result = await services.llm.complete(
			`${NORMALIZE_PROMPT}\n\nReceipt items: [${itemList}]`,
			{ tier: 'fast' },
		);
		const cleaned = result.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
		normalized = JSON.parse(cleaned) as NormalizedItem[];
	} catch (err) {
		services.logger.error('Failed to normalize receipt items: %s', err);
		return { updatedCount: 0, addedCount: 0, error: String(err) };
	}

	const normalMap = new Map(normalized.map((n) => [n.receiptName, n]));

	let priceData = await loadStorePrices(store, slug);
	if (!priceData.store || priceData.store === slug) {
		priceData = { ...priceData, store: receipt.store, slug };
	}

	let updatedCount = 0;
	let addedCount = 0;

	for (const li of validItems) {
		const norm = normalMap.get(li.name);
		if (!norm) continue;

		const entry: PriceEntry = {
			name: norm.normalizedName,
			price: li.totalPrice,
			unit: norm.unit,
			department: norm.department,
			updatedAt: receipt.date,
		};

		const existing = lookupPrice(priceData.items, norm.normalizedName);
		priceData = addOrUpdatePrice(priceData, entry);
		if (existing) { updatedCount++; } else { addedCount++; }
	}

	await saveStorePrices(store, priceData);
	return { updatedCount, addedCount };
}

// ─── Task 4: Text Intent Parsing ─────────────────────────────────────────────

const PRICE_UPDATE_RE = /\$\d+(?:\.\d+)?/;
const PRICE_UPDATE_VERBS = /\b(cost|price|are|is|was|costs|now|update|set)\b/i;

export function isPriceUpdateIntent(text: string): boolean {
	return PRICE_UPDATE_RE.test(text) && PRICE_UPDATE_VERBS.test(text);
}

export interface ParsedPriceUpdate {
	item: string;
	price: number;
	store: string;
	unit: string;
	department: string;
}

const PARSE_PRICE_PROMPT = `Extract a price update from this message. Return ONLY valid JSON (no markdown, no explanation):
{
  "item": "Eggs (60ct)",
  "price": 3.50,
  "store": "Costco",
  "unit": "60ct",
  "department": "Dairy"
}

Rules:
- item: normalized name with package size in parentheses
- price: the dollar amount mentioned
- store: the store mentioned, or "Unknown" if not specified
- unit: package size
- department: one of Dairy, Produce, Meat, Seafood, Bakery, Pantry, Frozen, Beverages, Snacks, Other`;

export async function parsePriceUpdateText(
	services: CoreServices,
	text: string,
): Promise<ParsedPriceUpdate | null> {
	try {
		const result = await services.llm.complete(
			`${PARSE_PRICE_PROMPT}\n\nMessage: "${sanitizeInput(text, 200)}"`,
			{ tier: 'fast' },
		);
		const cleaned = result.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
		const parsed = JSON.parse(cleaned) as ParsedPriceUpdate;
		if (!parsed.item || typeof parsed.price !== 'number') return null;
		return parsed;
	} catch (err) {
		services.logger.error('Failed to parse price update text: %s', err);
		return null;
	}
}
