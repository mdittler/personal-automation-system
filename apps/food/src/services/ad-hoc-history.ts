/**
 * Ad-hoc meal log dedup tracker (Phase H11.w).
 *
 * Maintains a rolling 30-day per-user history of free-text ad-hoc
 * meal logs. Used by the handler layer to detect when a user logs
 * similar text twice within the window, and auto-prompt
 * "save as quick-meal?".
 *
 * Similarity: Jaccard token overlap ≥ 0.5 on canonicalized lowercase
 * word tokens (stop words filtered via the shared STOP_WORDS set).
 *
 * Hardening:
 *   - Read-modify-write sequences serialized via per-store async lock
 *   - Corrupt YAML preserved as `.corrupt-<ts>` rather than silently zeroed
 *   - `recordAdHocLog` opportunistically trims expired entries and caps
 *     the array at MAX_ENTRIES with FIFO eviction
 *   - Future-dated entries (clock skew, timezone bug) treated as expired
 *     using a SIGNED date diff, not Math.abs
 *   - Stop-word filtering via shared `utils/stopwords.ts` (no length-only
 *     heuristic that lets "the", "and", "ate" leak through)
 */

import type { ScopedDataStore } from '@pas/core/types';
import { parse, stringify } from 'yaml';
import {
	generateFrontmatter,
	stripFrontmatter,
	buildAppTags,
} from '@pas/core/utils/frontmatter';
import { AsyncLock } from '../utils/async-lock.js';
import { STOP_WORDS } from '../utils/stopwords.js';

const FILE = 'ad-hoc-history.yaml';
const SIMILARITY_THRESHOLD = 0.5;
const WINDOW_DAYS = 30;
const MAX_ENTRIES = 500;

const lock = new AsyncLock();
const LOCK_KEY = FILE;

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
				// Unicode-aware: keep letters/numbers, replace anything else with space.
				.normalize('NFKD')
				.replace(/\p{Diacritic}/gu, '')
				.replace(/[^\p{L}\p{N}\s]/gu, ' ')
				.split(/\s+/)
				.filter((t) => t.length >= 2 && !STOP_WORDS.has(t)),
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
		if (!body.trim()) return { entries: [] };
		const parsed = parse(body) as StoreFile | null;
		return { entries: parsed?.entries ?? [] };
	} catch (err) {
		await preserveCorruptFile(store, raw, err);
		return { entries: [] };
	}
}

async function preserveCorruptFile(
	store: ScopedDataStore,
	raw: string,
	err: unknown,
): Promise<void> {
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const corruptPath = `corrupt/${FILE.replace('.yaml', '')}-${ts}.yaml`;
	try {
		await store.write(corruptPath, raw);
	} catch {
		// Best-effort.
	}
	// eslint-disable-next-line no-console
	console.error(
		`[ad-hoc-history] Corrupt YAML preserved as ${corruptPath}:`,
		(err as Error)?.message ?? err,
	);
}

async function write(store: ScopedDataStore, data: StoreFile): Promise<void> {
	const fm = generateFrontmatter({
		tags: buildAppTags('food', 'ad-hoc-history'),
		updated: new Date().toISOString(),
	});
	await store.write(FILE, `${fm}\n${stringify(data)}`);
}

/**
 * Signed days difference: positive means `later` is after `earlier`.
 * Future-dated `earlier` (clock skew, timezone bug, manual edit) gives a
 * negative result, which the window check below treats as "expired" — i.e.
 * we drop it rather than let it match forever.
 */
function signedDaysDiff(earlier: string, later: string): number {
	const da = new Date(earlier).getTime();
	const db = new Date(later).getTime();
	return (db - da) / (1000 * 60 * 60 * 24);
}

function isWithinWindow(entry: AdHocEntry, today: string): boolean {
	const diff = signedDaysDiff(entry.lastSeenDate, today);
	// Drop both expired (diff > WINDOW_DAYS) AND future-dated (diff < 0).
	return diff >= 0 && diff <= WINDOW_DAYS;
}

/**
 * Record an ad-hoc log. If the text matches an existing entry within the
 * 30-day window (Jaccard ≥ 0.5), increment its count; otherwise append a
 * new entry. Opportunistically trims stale entries and caps the array at
 * MAX_ENTRIES.
 */
export async function recordAdHocLog(
	store: ScopedDataStore,
	text: string,
	date: string,
): Promise<void> {
	const tokens = tokenize(text);
	await lock.run(LOCK_KEY, async () => {
		const f = await read(store);
		// Drop expired and future-dated entries on every write — cheap, keeps
		// the file bounded without a separate cron.
		f.entries = f.entries.filter((e) => isWithinWindow(e, date));
		const match = f.entries.find(
			(e) => jaccard(e.canonical, tokens) >= SIMILARITY_THRESHOLD,
		);
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
		// FIFO cap.
		while (f.entries.length > MAX_ENTRIES) {
			f.entries.shift();
		}
		await write(store, f);
	});
}

/**
 * Finds a similar prior entry within the last 30 days, if any.
 * Future-dated entries are excluded — see `signedDaysDiff` rationale.
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
			isWithinWindow(e, today),
	);
	return match ?? null;
}

/**
 * Removes expired or future-dated entries. Now mostly redundant with the
 * opportunistic sweep in `recordAdHocLog`, but kept for explicit-cleanup tests
 * and any future cron path.
 */
export async function trimExpired(
	store: ScopedDataStore,
	today: string,
): Promise<void> {
	await lock.run(LOCK_KEY, async () => {
		const f = await read(store);
		f.entries = f.entries.filter((e) => isWithinWindow(e, today));
		await write(store, f);
	});
}
