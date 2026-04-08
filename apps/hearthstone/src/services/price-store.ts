/**
 * Price store — per-store price database CRUD.
 *
 * Manages Obsidian-compatible .md files in shared/prices/.
 * Each store has its own file (e.g., prices/costco.md) with items
 * organized by department.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter } from '@pas/core/utils/frontmatter';
import type { PriceEntry, StorePriceData } from '../types.js';

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
