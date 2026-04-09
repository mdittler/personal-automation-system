#!/usr/bin/env tsx
/**
 * Phase H11.z — one-shot migration: add `canonicalName` to every pantry,
 * recipe, and grocery ingredient lacking one.
 *
 * Uses the deterministic fast-path from `ingredient-normalizer.ts`. Entries
 * the deterministic path cannot confidently resolve are logged to
 * `data/system/food/migration-unresolved.log` for manual review — we do NOT
 * guess. Re-run this script with an LLM-backed version (or trust the runtime
 * normalizer which falls back to LLM) to resolve them later.
 *
 * Idempotent: entries that already carry `canonicalName` are skipped.
 *
 * Usage:
 *   pnpm tsx apps/food/scripts/migrate-ingredient-canonical.ts
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import {
	deterministicCanonical,
	deterministicIsConfident,
} from '../src/services/ingredient-normalizer.js';

interface UnresolvedEntry {
	file: string;
	name: string;
	reason: string;
}

interface Stats {
	filesScanned: number;
	filesUpdated: number;
	entriesUpdated: number;
	entriesSkipped: number;
	unresolved: UnresolvedEntry[];
}

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const SHARED_FOOD_DIR = join(REPO_ROOT, 'data', 'users', 'shared', 'food');
const UNRESOLVED_LOG = join(REPO_ROOT, 'data', 'system', 'food', 'migration-unresolved.log');

/** Strip a YAML frontmatter block (`---\n...\n---\n`) if present. */
function stripFrontmatter(raw: string): { frontmatter: string; body: string } {
	if (!raw.startsWith('---\n')) return { frontmatter: '', body: raw };
	const end = raw.indexOf('\n---\n', 4);
	if (end === -1) return { frontmatter: '', body: raw };
	return {
		frontmatter: raw.slice(0, end + 5),
		body: raw.slice(end + 5),
	};
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const tmp = `${path}.tmp-${process.pid}`;
	await writeFile(tmp, content, 'utf8');
	await rename(tmp, path);
}

/**
 * Normalize a single ingredient-like object in place. Returns true if the
 * object was mutated. Logs to `unresolved` when the deterministic path is
 * not confident.
 */
function normalizeInPlace(
	obj: { name?: unknown; canonicalName?: unknown },
	file: string,
	stats: Stats,
): boolean {
	if (!obj || typeof obj !== 'object') return false;
	if (typeof obj.name !== 'string' || !obj.name.trim()) return false;
	if (typeof obj.canonicalName === 'string' && obj.canonicalName.trim()) {
		stats.entriesSkipped++;
		return false;
	}

	const canonical = deterministicCanonical(obj.name);
	if (!deterministicIsConfident(obj.name, canonical)) {
		stats.unresolved.push({
			file,
			name: obj.name,
			reason: canonical
				? `deterministic path low-confidence (got "${canonical}")`
				: 'deterministic path returned empty',
		});
		// Still write the best-effort canonical so runtime equality has
		// *something* to match on; the LLM pass can overwrite later.
		obj.canonicalName = canonical || obj.name.trim().toLowerCase();
	} else {
		obj.canonicalName = canonical;
	}
	stats.entriesUpdated++;
	return true;
}

/** Migrate `pantry.yaml`. */
async function migratePantry(stats: Stats): Promise<void> {
	const path = join(SHARED_FOOD_DIR, 'pantry.yaml');
	if (!existsSync(path)) return;
	stats.filesScanned++;

	const raw = await readFile(path, 'utf8');
	const { frontmatter, body } = stripFrontmatter(raw);
	const data = parse(body);
	if (!data || typeof data !== 'object') return;

	const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : null;
	if (!items) return;

	let dirty = false;
	for (const item of items) {
		if (normalizeInPlace(item, path, stats)) dirty = true;
	}
	if (dirty) {
		const out = Array.isArray(data) ? stringify(items) : stringify({ ...data, items });
		await atomicWrite(path, frontmatter + out);
		stats.filesUpdated++;
	}
}

/** Migrate every `recipes/*.yaml` file. */
async function migrateRecipes(stats: Stats): Promise<void> {
	const dir = join(SHARED_FOOD_DIR, 'recipes');
	if (!existsSync(dir)) return;

	const entries = await readdir(dir);
	for (const entry of entries) {
		if (!entry.endsWith('.yaml')) continue;
		const path = join(dir, entry);
		stats.filesScanned++;

		const raw = await readFile(path, 'utf8');
		const { frontmatter, body } = stripFrontmatter(raw);
		const recipe = parse(body);
		if (!recipe || typeof recipe !== 'object' || !Array.isArray(recipe.ingredients)) continue;

		let dirty = false;
		for (const ing of recipe.ingredients) {
			if (normalizeInPlace(ing, path, stats)) dirty = true;
		}
		if (dirty) {
			await atomicWrite(path, frontmatter + stringify(recipe));
			stats.filesUpdated++;
		}
	}
}

/** Migrate `grocery/active.yaml` (if present). */
async function migrateGrocery(stats: Stats): Promise<void> {
	const path = join(SHARED_FOOD_DIR, 'grocery', 'active.yaml');
	if (!existsSync(path)) return;
	stats.filesScanned++;

	const raw = await readFile(path, 'utf8');
	const { frontmatter, body } = stripFrontmatter(raw);
	const data = parse(body);
	if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return;

	let dirty = false;
	for (const item of data.items) {
		if (normalizeInPlace(item, path, stats)) dirty = true;
	}
	if (dirty) {
		await atomicWrite(path, frontmatter + stringify(data));
		stats.filesUpdated++;
	}
}

async function writeUnresolvedLog(stats: Stats): Promise<void> {
	if (stats.unresolved.length === 0) return;
	await mkdir(dirname(UNRESOLVED_LOG), { recursive: true });
	const lines = stats.unresolved.map(
		(u) => `${new Date().toISOString()}\t${u.file}\t${u.name}\t${u.reason}`,
	);
	await writeFile(UNRESOLVED_LOG, `${lines.join('\n')}\n`, 'utf8');
}

async function main(): Promise<void> {
	if (!existsSync(SHARED_FOOD_DIR)) {
		console.log(`No food data directory at ${SHARED_FOOD_DIR}; nothing to migrate.`);
		return;
	}

	const stats: Stats = {
		filesScanned: 0,
		filesUpdated: 0,
		entriesUpdated: 0,
		entriesSkipped: 0,
		unresolved: [],
	};

	await migratePantry(stats);
	await migrateRecipes(stats);
	await migrateGrocery(stats);
	await writeUnresolvedLog(stats);

	console.log('── Phase H11.z migration summary ──');
	console.log(`Files scanned:    ${stats.filesScanned}`);
	console.log(`Files updated:    ${stats.filesUpdated}`);
	console.log(`Entries updated:  ${stats.entriesUpdated}`);
	console.log(`Entries skipped:  ${stats.entriesSkipped} (already had canonicalName)`);
	console.log(`Unresolved:       ${stats.unresolved.length}`);
	if (stats.unresolved.length > 0) {
		console.log(`  → logged to ${UNRESOLVED_LOG}`);
		console.log('  → re-run with an LLM-backed normalizer to resolve.');
	}
}

main().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
