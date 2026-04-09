/**
 * Ad-hoc meal log dedup tracker (Phase H11.w).
 *
 * Maintains a rolling 30-day per-user history of free-text ad-hoc
 * meal logs. Used by the handler layer to detect when a user logs
 * similar text twice within the window, and auto-prompt
 * "save as quick-meal?".
 *
 * Similarity: Jaccard token overlap ≥ 0.5 on canonicalized
 * lowercase word tokens (stop words ignored via min-length filter).
 */

import type { ScopedDataStore } from '@pas/core/types';
import { parse, stringify } from 'yaml';
import {
	generateFrontmatter,
	stripFrontmatter,
	buildAppTags,
} from '@pas/core/utils/frontmatter';

const FILE = 'ad-hoc-history.yaml';
const SIMILARITY_THRESHOLD = 0.5;
const WINDOW_DAYS = 30;

export interface AdHocEntry {
	canonical: string[]; // sorted, deduped lowercase tokens
	text: string; // raw original text
	occurrences: number;
	firstSeenDate: string; // YYYY-MM-DD
	lastSeenDate: string;
}

interface StoreFile {
	entries: AdHocEntry[];
}

function tokenize(s: string): string[] {
	return Array.from(
		new Set(
			s
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, ' ')
				.split(/\s+/)
				.filter((t) => t.length > 2),
		),
	).sort();
}

function jaccard(a: string[], b: string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	let inter = 0;
	for (const t of setA) {
		if (setB.has(t)) inter++;
	}
	const union = setA.size + setB.size - inter;
	return union === 0 ? 0 : inter / union;
}

async function read(store: ScopedDataStore): Promise<StoreFile> {
	const raw = await store.read(FILE);
	if (!raw) return { entries: [] };
	try {
		const body = stripFrontmatter(raw);
		const parsed = parse(body) as StoreFile | null;
		return { entries: parsed?.entries ?? [] };
	} catch {
		return { entries: [] };
	}
}

async function write(store: ScopedDataStore, data: StoreFile): Promise<void> {
	const fm = generateFrontmatter({
		tags: buildAppTags('food', 'ad-hoc-history'),
		updated: new Date().toISOString(),
	});
	await store.write(FILE, `${fm}\n${stringify(data)}`);
}

function daysBetween(a: string, b: string): number {
	const da = new Date(a).getTime();
	const db = new Date(b).getTime();
	return Math.abs(db - da) / (1000 * 60 * 60 * 24);
}

/**
 * Record an ad-hoc log. If the text matches an existing entry
 * (Jaccard ≥ 0.5), increment its count; otherwise append new.
 */
export async function recordAdHocLog(
	store: ScopedDataStore,
	text: string,
	date: string,
): Promise<void> {
	const tokens = tokenize(text);
	const f = await read(store);
	const match = f.entries.find((e) => jaccard(e.canonical, tokens) >= SIMILARITY_THRESHOLD);
	if (match) {
		match.occurrences += 1;
		match.lastSeenDate = date;
	} else {
		f.entries.push({
			canonical: tokens,
			text,
			occurrences: 1,
			firstSeenDate: date,
			lastSeenDate: date,
		});
	}
	await write(store, f);
}

/**
 * Finds a similar prior entry within the last 30 days, if any.
 * Stale entries (lastSeenDate older than WINDOW_DAYS relative to `today`)
 * are ignored in-memory so callers don't need to call `trimExpired` first.
 */
export async function findSimilarAdHoc(
	store: ScopedDataStore,
	text: string,
	today: string = new Date().toISOString().slice(0, 10),
): Promise<AdHocEntry | null> {
	const tokens = tokenize(text);
	const f = await read(store);
	const match = f.entries.find(
		(e) =>
			jaccard(e.canonical, tokens) >= SIMILARITY_THRESHOLD &&
			daysBetween(e.lastSeenDate, today) <= WINDOW_DAYS,
	);
	return match ?? null;
}

/**
 * Removes entries whose `lastSeenDate` is older than 30 days
 * relative to `today`.
 */
export async function trimExpired(
	store: ScopedDataStore,
	today: string,
): Promise<void> {
	const f = await read(store);
	f.entries = f.entries.filter((e) => daysBetween(e.lastSeenDate, today) <= WINDOW_DAYS);
	await write(store, f);
}
