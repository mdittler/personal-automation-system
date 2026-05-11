/**
 * Case loader for the Persona Regression Suite (REQ-REG-002).
 *
 * Walks a cases directory and returns `LoadedCase[]` (each carries the
 * absolute file path so `computeCacheKey` can hash the case definition
 * alongside the coverage paths).
 *
 * Two case-definition formats are supported:
 *
 *  - `*.case.ts` files with a default export of type `PersonaCase`.
 *  - `index.ts` files that export `buildCases(): LoadedCase[]`. Used by
 *    generated case modules (e.g. the FOOD_PERSONAS mirror) to avoid
 *    hand-maintaining one file per intent.
 *
 * Every case runs through `validatePersonaCase`; the first duplicate `id`
 * encountered fails the load. Returned cases are sorted by `id` so the
 * orchestrator dispatches deterministically.
 */

import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LoadedCase, PersonaCase } from '@core/types/regression.js';
import { validatePersonaCase } from '../shared/validate-case.js';

export async function loadCases(rootDir: string): Promise<LoadedCase[]> {
	const absRoot = resolve(rootDir);
	const out: LoadedCase[] = [];
	const seen = new Map<string, string>();

	await walk(absRoot, async (filePath) => {
		const name = basename(filePath);
		if (name.endsWith('.case.ts')) {
			const mod = (await import(pathToFileURL(filePath).href)) as { default?: unknown };
			if (mod.default === undefined) {
				throw new Error(`${filePath}: missing default export (expected export default <PersonaCase>)`);
			}
			const c = mod.default as PersonaCase;
			validatePersonaCase(c);
			register({ case: c, filePath });
		} else if (name === 'index.ts') {
			const mod = (await import(pathToFileURL(filePath).href)) as {
				buildCases?: () => LoadedCase[];
			};
			if (typeof mod.buildCases !== 'function') {
				throw new Error(`${filePath}: index.ts must export buildCases(): LoadedCase[]`);
			}
			for (const lc of mod.buildCases()) {
				validatePersonaCase(lc.case);
				register(lc);
			}
		}
	});

	return out.sort((a, b) => a.case.id.localeCompare(b.case.id));

	function register(lc: LoadedCase): void {
		const prev = seen.get(lc.case.id);
		if (prev) {
			throw new Error(`duplicate case id "${lc.case.id}": ${prev} and ${lc.filePath}`);
		}
		seen.set(lc.case.id, lc.filePath);
		out.push(lc);
	}
}

async function walk(dir: string, visit: (path: string) => Promise<void>): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		// Empty / missing directory is a no-op — callers (notably orchestrator unit
		// tests) pass freshly-created temp dirs.
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw err;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) await walk(p, visit);
		else await visit(p);
	}
}
