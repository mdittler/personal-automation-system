/**
 * Receipt query helpers.
 *
 * Answers deterministic follow-up questions from stored receipt records instead
 * of relying on generic chat memory or DataQueryService file selection.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse } from 'yaml';
import type {
	PriceEntry,
	Receipt,
	ReceiptLineItem,
	ReceiptPriceUpdate,
	StorePriceData,
} from '../types.js';
import { escapeMarkdown } from '../utils/escape-markdown.js';
import { listStores, loadStorePrices } from './price-store.js';
import {
	type ParsedSize,
	calculateUnitPrice,
	formatUnitPriceToken,
	parseSizeString,
} from './unit-normalizer.js';

const RECEIPTS_DIR = 'receipts';

const EXPLICIT_RECEIPT_RE = /\b(receipt|last\s+trip|trip\s+to|shopping\s+trip)\b/i;
const RECEIPT_FOLLOW_UP_RE =
	/\b(line\s*items?|items?|total|break\s*out|price\s+of\s+each|each\s+item|what\s+(?:did|was)\s+(?:i|we))\b/i;
const NEW_STATUS_RE = /\b(new|added|updated|price(?:s)?\s+updated)\b/i;
const PRICE_LOOKUP_RE =
	/\b(cheapest|how\s+much\s+(?:are|is|was|were)|price\s+(?:of|for)|cost\s+(?:of|for))\b/i;
const PRICE_LOOKUP_EXCLUDE_RE = /\b(spend|spent|spending|budget|receipt|trip|meal\s+plan)\b/i;
const STORE_SPENDING_RE =
	/\b(spend|spent|spending|cost)\b.*\b(each\s+)?(grocery\s+)?stores?\b|\b(grocery\s+)?stores?\b.*\b(spend|spent|spending|cost)\b/i;
const ITEM_STOPWORDS = new Set([
	'a',
	'an',
	'are',
	'at',
	'buy',
	'cheapest',
	'cost',
	'do',
	'does',
	'for',
	'from',
	'how',
	'is',
	'much',
	'of',
	'place',
	'price',
	'spot',
	'store',
	'tell',
	'the',
	'to',
	'was',
	'were',
]);

function isReceipt(value: unknown): value is Receipt {
	if (!value || typeof value !== 'object') return false;
	const r = value as Partial<Receipt>;
	return (
		typeof r.id === 'string' &&
		typeof r.store === 'string' &&
		typeof r.date === 'string' &&
		Array.isArray(r.lineItems) &&
		typeof r.total === 'number'
	);
}

function receiptSortKey(receipt: Receipt): string {
	return receipt.capturedAt || `${receipt.date}T00:00:00.000Z`;
}

function normalizeStoreName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function normalizeItemToken(value: string): string {
	if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
	if (value.endsWith('s') && value.length > 3) return value.slice(0, -1);
	return value;
}

function tokenizeItem(value: string): string[] {
	return value
		.toLowerCase()
		.replace(/\([^)]*\)/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.split(/\s+/)
		.map(normalizeItemToken)
		.filter((token) => token.length > 1 && !ITEM_STOPWORDS.has(token));
}

function normalizeReceiptPath(path: string): string | null {
	const normalized = path.replace(/\\/g, '/');
	const match = normalized.match(/(?:^|\/)receipts\/([^/]+\.(?:ya?ml))$/i);
	if (!match) return null;
	return `${RECEIPTS_DIR}/${match[1]}`;
}

function formatMoney(value: number): string {
	return `$${value.toFixed(2)}`;
}

function cleanStoreDisplayName(value: string): string {
	return value
		.replace(/^"+|"+$/g, '')
		.replace(/\\"/g, '"')
		.trim();
}

function formatLineItem(item: ReceiptLineItem, update?: ReceiptPriceUpdate): string {
	const status = update ? ` (${update.status === 'added' ? 'new' : 'updated'})` : '';
	const normalized =
		update && update.normalizedName.toLowerCase() !== item.name.toLowerCase()
			? ` -> ${escapeMarkdown(update.normalizedName)}`
			: '';
	return `- ${escapeMarkdown(item.name)}${normalized}: ${formatMoney(item.totalPrice)}${status}`;
}

function formatPriceUpdate(update: ReceiptPriceUpdate): string {
	const normalized =
		update.normalizedName.toLowerCase() !== update.receiptName.toLowerCase()
			? ` -> ${escapeMarkdown(update.normalizedName)}`
			: '';
	return `- ${escapeMarkdown(update.receiptName)}${normalized}: ${formatMoney(update.price)} (${update.status === 'added' ? 'new' : 'updated'})`;
}

export async function loadReceipts(store: ScopedDataStore): Promise<Receipt[]> {
	const files = await store.list(RECEIPTS_DIR);
	const receipts: Receipt[] = [];

	for (const file of files) {
		if (!/\.ya?ml$/i.test(file)) continue;
		const raw = await store.read(`${RECEIPTS_DIR}/${file}`);
		if (!raw) continue;
		try {
			const parsed = parse(stripFrontmatter(raw));
			if (isReceipt(parsed)) receipts.push(parsed);
		} catch {
			// Ignore malformed receipt sidecars; query should still answer from good data.
		}
	}

	return receipts.sort((a, b) => receiptSortKey(b).localeCompare(receiptSortKey(a)));
}

export async function loadRecentReceiptFromPaths(
	store: ScopedDataStore,
	filePaths: readonly string[],
): Promise<Receipt | null> {
	for (const path of filePaths) {
		const receiptPath = normalizeReceiptPath(path);
		if (!receiptPath) continue;
		const raw = await store.read(receiptPath);
		if (!raw) continue;
		try {
			const parsed = parse(stripFrontmatter(raw));
			if (isReceipt(parsed)) return parsed;
		} catch {}
	}
	return null;
}

export function isReceiptQueryIntent(text: string, hasRecentReceiptContext = false): boolean {
	return (
		EXPLICIT_RECEIPT_RE.test(text) || (hasRecentReceiptContext && RECEIPT_FOLLOW_UP_RE.test(text))
	);
}

export function isPriceLookupIntent(text: string): boolean {
	return PRICE_LOOKUP_RE.test(text) && !PRICE_LOOKUP_EXCLUDE_RE.test(text);
}

export function isStoreSpendingIntent(text: string): boolean {
	return STORE_SPENDING_RE.test(text);
}

export function findLatestReceipt(
	receipts: readonly Receipt[],
	storeName?: string,
): Receipt | null {
	const wanted = storeName ? normalizeStoreName(storeName) : '';
	return (
		receipts.find((receipt) => {
			if (!wanted) return true;
			return normalizeStoreName(receipt.store).includes(wanted);
		}) ?? null
	);
}

export function findMentionedReceiptStore(
	text: string,
	receipts: readonly Receipt[],
): string | undefined {
	const normalizedText = normalizeStoreName(text);
	const stores = [...new Set(receipts.map((receipt) => receipt.store))];
	return stores.find((store) => normalizedText.includes(normalizeStoreName(store)));
}

export function formatReceiptDetails(receipt: Receipt, text: string): string {
	const wantsStatus = NEW_STATUS_RE.test(text);
	const updates = receipt.priceUpdates ?? [];

	if (wantsStatus && updates.length > 0) {
		const added = updates.filter((u) => u.status === 'added').length;
		const updated = updates.filter((u) => u.status === 'updated').length;
		return [
			`${receipt.store} receipt (${receipt.date}) price updates: ${updated} updated, ${added} new`,
			...updates.map(formatPriceUpdate),
			`Total receipt spend: ${formatMoney(receipt.total)}`,
		].join('\n');
	}

	const updateByReceiptName = new Map(
		updates.map((update) => [update.receiptName.toLowerCase(), update]),
	);
	const allLines = receipt.lineItems.map((item) =>
		formatLineItem(item, updateByReceiptName.get(item.name.toLowerCase())),
	);

	const header = `${receipt.store} receipt (${receipt.date}) - ${receipt.lineItems.length} items`;
	const footer = [
		`Subtotal: ${receipt.subtotal == null ? 'n/a' : formatMoney(receipt.subtotal)}`,
		receipt.tax == null ? null : `Tax: ${formatMoney(receipt.tax)}`,
		`Total: ${formatMoney(receipt.total)}`,
	].filter((line): line is string => line !== null);

	const MAX_RECEIPT_CHARS = 3500;
	const footerText = footer.join('\n');
	// Reserve space for header + footer + newlines + truncation marker
	let budget = MAX_RECEIPT_CHARS - header.length - footerText.length - 4;
	const includedLines: string[] = [];
	for (const line of allLines) {
		if (budget - line.length - 1 < 50) break;
		includedLines.push(line);
		budget -= line.length + 1;
	}

	const omitted = allLines.length - includedLines.length;
	const parts: string[] = [header, ...includedLines];
	if (omitted > 0) parts.push(`…and ${omitted} more items`);
	parts.push(...footer);
	return parts.join('\n');
}

export async function loadAllStorePrices(store: ScopedDataStore): Promise<StorePriceData[]> {
	const slugs = await listStores(store);
	const all: StorePriceData[] = [];
	for (const slug of slugs) {
		const priceData = await loadStorePrices(store, slug);
		if (priceData.items.length > 0) {
			all.push({
				...priceData,
				store: cleanStoreDisplayName(priceData.store),
			});
		}
	}
	return all;
}

export function findMentionedPriceStore(
	text: string,
	priceData: readonly StorePriceData[],
): string | undefined {
	const normalizedText = normalizeStoreName(text);
	return priceData
		.map((data) => data.store)
		.find((store) => normalizedText.includes(normalizeStoreName(store)));
}

export function extractPriceItem(text: string, storeNames: readonly string[] = []): string | null {
	let lower = text.toLowerCase().replace(/[?!.,]/g, ' ');
	for (const store of storeNames) {
		const normalizedStore = normalizeStoreName(store);
		lower = lower.replace(
			new RegExp(`\\b${normalizedStore.replace(/\s+/g, '\\s+')}\\b`, 'gi'),
			' ',
		);
	}

	const patterns = [
		// Batch 3 — broadened "cheapest X" pattern. Old: required `buy\s+` directly
		// after `cheapest`, which missed phrases like "cheapest blueberries among
		// the stores...". New: optional "(place (to|for))? (get|buy|find)" prefix;
		// captures lazily until a trailing prepositional phrase (at/from/among/
		// in/near/for) or end-of-string.
		/\bcheapest\b\s+(?:place\s+(?:to|for)\s+(?:get|buy|find)\s+|(?:to\s+)?(?:get|buy|find)\s+)?(.+?)(?:\s+(?:at|from|among|in|near|for)\b|$)/i,
		/\bhow\s+much\s+(?:are|is|was|were)\s+(.+?)(?:\s+\bat\b|\s+\bfrom\b|$)/i,
		/\b(?:price|cost)\s+(?:of|for)\s+(.+?)(?:\s+\bat\b|\s+\bfrom\b|$)/i,
	];

	for (const pattern of patterns) {
		const match = lower.match(pattern);
		if (!match?.[1]) continue;
		const item = tokenizeItem(match[1]).join(' ');
		if (item) return item;
	}

	return null;
}

function itemMatchScore(entry: PriceEntry, itemQuery: string): number {
	const queryTokens = tokenizeItem(itemQuery);
	if (queryTokens.length === 0) return 0;
	const entryTokens = tokenizeItem(entry.name);
	const entryTokenSet = new Set(entryTokens);
	const matched = queryTokens.filter((token) => entryTokenSet.has(token)).length;
	if (matched === queryTokens.length) return 100 + matched;
	return matched;
}

interface PriceMatch {
	store: string;
	entry: PriceEntry;
	score: number;
}

export function findPriceMatches(
	priceData: readonly StorePriceData[],
	itemQuery: string,
	storeName?: string,
): PriceMatch[] {
	const wantedStore = storeName ? normalizeStoreName(storeName) : '';
	const matches: PriceMatch[] = [];
	for (const data of priceData) {
		if (wantedStore && !normalizeStoreName(data.store).includes(wantedStore)) continue;
		for (const entry of data.items) {
			const score = itemMatchScore(entry, itemQuery);
			if (score <= 0) continue;
			matches.push({ store: data.store, entry, score });
		}
	}
	return matches.sort((a, b) => b.score - a.score || a.entry.price - b.entry.price);
}

export function formatStorePriceAnswer(
	priceData: readonly StorePriceData[],
	itemQuery: string,
	storeName: string,
): string {
	const matches = findPriceMatches(priceData, itemQuery, storeName).slice(0, 3);
	if (matches.length === 0) {
		return `I do not have a saved ${escapeMarkdown(itemQuery)} price for ${escapeMarkdown(storeName)} yet.`;
	}

	const best = matches[0];
	if (!best) {
		return `I do not have a saved ${escapeMarkdown(itemQuery)} price for ${escapeMarkdown(storeName)} yet.`;
	}
	const others = matches.slice(1);
	const lines = [
		`${escapeMarkdown(best.store)}: ${escapeMarkdown(best.entry.name)} is ${formatMoney(best.entry.price)}${best.entry.updatedAt ? ` (updated ${best.entry.updatedAt})` : ''}.`,
	];
	if (others.length > 0) {
		lines.push(
			`Also found: ${others
				.map((match) => `${escapeMarkdown(match.entry.name)} ${formatMoney(match.entry.price)}`)
				.join(', ')}.`,
		);
	}
	return lines.join('\n');
}

function isValidPriceNumber(price: unknown): price is number {
	return typeof price === 'number' && Number.isFinite(price) && price > 0;
}

export function formatCheapestPriceAnswer(
	priceData: readonly StorePriceData[],
	itemQuery: string,
): string {
	const allMatches = findPriceMatches(priceData, itemQuery);

	// Step 1: filter out entries with invalid price (NaN, Infinity, ≤0).
	const matches = allMatches.filter((m) => isValidPriceNumber(m.entry.price));
	if (matches.length === 0) {
		return `I do not have saved prices for ${escapeMarkdown(itemQuery)} yet.`;
	}

	// Step 2: parse each entry's unit string at comparison time.
	const parsedMatches = matches.map((m) => ({
		match: m,
		parsed: parseSizeString(m.entry.unit) as ParsedSize | null,
	}));

	// Step 3: unit-price mode iff ALL parse, ALL share the same base, AND ≥2 entries.
	const allParsed = parsedMatches.every((p) => p.parsed !== null);
	const firstBase = parsedMatches[0]?.parsed?.base;
	const allSameBase =
		allParsed &&
		firstBase !== undefined &&
		parsedMatches.every((p) => p.parsed?.base === firstBase);
	const useUnitMode = allParsed && allSameBase && parsedMatches.length >= 2;

	if (useUnitMode && firstBase) {
		// Compute unit price per entry; pick lowest. Tiebreak: alphabetical by store name.
		const ranked = parsedMatches
			.map((p) => ({
				match: p.match,
				// p.parsed is non-null here because allParsed === true
				// biome-ignore lint/style/noNonNullAssertion: guarded by allParsed
				unitPrice: calculateUnitPrice(p.match.entry.price, p.parsed!),
			}))
			.sort((a, b) => {
				if (a.unitPrice !== b.unitPrice) return a.unitPrice - b.unitPrice;
				return a.match.store.localeCompare(b.match.store);
			});

		const winner = ranked[0];
		if (!winner) {
			return `I do not have saved prices for ${escapeMarkdown(itemQuery)} yet.`;
		}
		const token = formatUnitPriceToken(winner.unitPrice, firstBase);
		const updated = winner.match.entry.updatedAt
			? ` (updated ${winner.match.entry.updatedAt})`
			: '';
		return `Lowest saved unit price for ${escapeMarkdown(itemQuery)}: ${escapeMarkdown(winner.match.entry.name)} at ${formatMoney(winner.match.entry.price)} (${token}) at ${escapeMarkdown(winner.match.store)}${updated}.`;
	}

	// Package-price mode: lowest price; tiebreak alphabetical by store name.
	const cheapest = [...matches].sort((a, b) => {
		if (a.entry.price !== b.entry.price) return a.entry.price - b.entry.price;
		return a.store.localeCompare(b.store);
	})[0];
	if (!cheapest) {
		return `I do not have saved prices for ${escapeMarkdown(itemQuery)} yet.`;
	}
	return `Lowest saved package price for ${escapeMarkdown(itemQuery)}: ${escapeMarkdown(cheapest.entry.name)} at ${formatMoney(cheapest.entry.price)} at ${escapeMarkdown(cheapest.store)}${cheapest.entry.updatedAt ? ` (updated ${cheapest.entry.updatedAt})` : ''}.`;
}

export function formatStoreSpendingAnswer(receipts: readonly Receipt[]): string {
	if (receipts.length === 0) return 'I do not have any grocery receipts saved yet.';

	const byStore = new Map<string, { count: number; total: number; lastDate: string }>();
	for (const receipt of receipts) {
		const key = cleanStoreDisplayName(receipt.store);
		const existing = byStore.get(key) ?? { count: 0, total: 0, lastDate: '' };
		byStore.set(key, {
			count: existing.count + 1,
			total: existing.total + receipt.total,
			lastDate: receipt.date > existing.lastDate ? receipt.date : existing.lastDate,
		});
	}

	const lines = [...byStore.entries()]
		.sort((a, b) => b[1].total - a[1].total)
		.map(([store, stats]) => {
			const average = stats.total / stats.count;
			const tripWord = stats.count === 1 ? 'trip' : 'trips';
			return `- ${escapeMarkdown(store)}: avg ${formatMoney(average)} per trip across ${stats.count} ${tripWord} (total ${formatMoney(stats.total)}, last ${stats.lastDate})`;
		});

	return ['Grocery spending by store:', ...lines].join('\n');
}
