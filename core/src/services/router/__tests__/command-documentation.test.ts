/**
 * Doc-coverage gate (Batch 1F).
 *
 * Asserts that every slash command in the per-user effective catalog
 * (admin and non-admin views combined) is mentioned in the
 * AppKnowledgeBase-indexed help content — the same truncated 2000-char
 * slice the chatbot's runtime search sees. Aliases must each appear
 * independently. A structured allowlist in
 * `core/config/undocumented-commands.yaml` permits temporary exceptions
 * with required `command` / `reason` / `owner` fields, rejecting orphan
 * entries (command no longer in the catalog) and expired entries.
 *
 * Loader provenance: this test calls `loadIndexedEntries` directly so it
 * exercises exactly the same pipeline `AppKnowledgeBase.init()` uses at
 * runtime — including `MAX_CONTENT_LENGTH` truncation. Reimplementing
 * loading in the test would let the gate drift away from what the chatbot
 * actually sees.
 *
 * Enablement gate (Codex correction I4): in this doc-coverage path,
 * `buildLiveDeps` forces `isAppEnabledForUser: () => true` so the catalog
 * covers every command that could ever be dispatched, including apps a
 * particular live user has disabled. Per-user enablement filtering is
 * exercised separately by the prompt-injection tests (Batch 1B) and the
 * `/help` tests (Batch 1B+).
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';
import { loadIndexedEntries } from '../../app-knowledge/index.js';
import type { RegisteredApp } from '../../app-registry/index.js';
import {
	type CommandCatalogDeps,
	type CommandCatalogEntry,
	getEffectiveCommandCatalog,
} from '../command-catalog.js';

// ESM equivalent of `__dirname` (this project is ESM-only).
const HERE = dirname(fileURLToPath(import.meta.url));

// From this test file to the repo root: `__tests__` → `router` → `services`
// → `src` → `core` → repo root. Five `..` segments.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const INFRA_DOCS = join(REPO_ROOT, 'core', 'docs', 'help');
const APPS_DIR = join(REPO_ROOT, 'apps');
const ALLOWLIST_PATH = join(REPO_ROOT, 'core', 'config', 'undocumented-commands.yaml');

/** Minimal shape pulled out of `apps/<id>/manifest.yaml` for the doc-cov gate. */
interface DiscoveredApp {
	appId: string;
	appDir: string;
	manifest: {
		app: { id: string };
		capabilities?: {
			messages?: {
				commands?: Array<{ name: string; description?: string; args?: string[] }>;
			};
		};
	};
}

interface AllowlistEntry {
	command: string;
	reason: string;
	owner: string;
	expires?: string;
}

interface AllowlistFile {
	entries?: AllowlistEntry[];
}

/**
 * Discover apps from disk by walking `apps/*` and reading each
 * `manifest.yaml`. Mirrors the production `AppRegistry.loadAll()` shape
 * closely enough that `getEffectiveCommandCatalog` can consume it via the
 * registry-like wrapper in `buildLiveDeps`.
 */
async function discoverApps(repoRoot: string): Promise<DiscoveredApp[]> {
	let entries: string[];
	try {
		entries = await readdir(join(repoRoot, 'apps'));
	} catch {
		return [];
	}

	const out: DiscoveredApp[] = [];
	for (const entry of entries) {
		const appDir = join(APPS_DIR, entry);
		const manifestPath = join(appDir, 'manifest.yaml');
		let raw: string;
		try {
			raw = await readFile(manifestPath, 'utf-8');
		} catch {
			continue;
		}
		const parsed = yaml.parse(raw) as DiscoveredApp['manifest'] | null;
		const appId = parsed?.app?.id;
		if (!parsed || typeof appId !== 'string' || appId.length === 0) continue;
		out.push({ appId, appDir, manifest: parsed });
	}
	return out;
}

/**
 * Build live `CommandCatalogDeps` against the on-disk repo state.
 *
 * - `registry.getAll()` wraps the discovered apps in a minimal
 *   `RegisteredApp`-shaped object; we never instantiate the real registry.
 * - `isAppEnabledForUser` is hardcoded to `true` (see file-level note).
 * - `isUserAdmin` is parameterized so the test can build both admin and
 *   non-admin catalogs and union them.
 */
function buildLiveDeps(opts: { admin: boolean; apps: DiscoveredApp[] }): CommandCatalogDeps {
	const registered: RegisteredApp[] = opts.apps.map(
		(a) =>
			({
				manifest: a.manifest,
				appDir: a.appDir,
				// `module` is unused by `getEffectiveCommandCatalog`; we never load app code.
				module: undefined as never,
			}) as unknown as RegisteredApp,
	);
	return {
		registry: { getAll: () => registered },
		isUserAdmin: () => opts.admin,
		isAppEnabledForUser: () => true,
		conversationServiceWired: true,
	};
}

/**
 * Concatenate every indexed entry's content. The doc-coverage check looks
 * for the literal `/cmdname` token anywhere in this joined string. Using
 * the exact `loadIndexedEntries` output guarantees the gate validates
 * against the truncated content the chatbot actually sees.
 */
async function buildIndexedContent(apps: DiscoveredApp[]): Promise<string> {
	const indexedApps = apps.map((a) => ({ appId: a.appId, appDir: a.appDir }));
	const entries = await loadIndexedEntries({
		infraDocsDir: INFRA_DOCS,
		apps: indexedApps,
	});
	return entries.map((e) => e.content).join('\n');
}

/**
 * Word-bounded, case-insensitive match for a literal slash command token.
 *
 * Why this shape: the chatbot's runtime search splits the user's question
 * into keywords, but the doc-coverage gate must verify that the literal
 * `/cmdname` slash form appears in the indexed content. Otherwise the
 * chatbot can't direct the user to the right command by name.
 *
 * Word-bounded matching is enforced by requiring a non-`[A-Za-z0-9_]`
 * character (or beginning/end of string) on each side of the match. This
 * prevents `/note` from matching the substring "footnote" — a real risk
 * given the truncated indexed content uses the same lowercased keyword
 * search downstream.
 */
function tokenMatch(haystack: string, command: string): boolean {
	const escaped = command.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
	const re = new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`, 'i');
	return re.test(haystack);
}

/** Dedupe catalog entries by canonical command name, preserving first occurrence. */
function dedupeByCanonical(entries: CommandCatalogEntry[]): CommandCatalogEntry[] {
	const seen = new Set<string>();
	const out: CommandCatalogEntry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.canonical)) continue;
		seen.add(entry.canonical);
		out.push(entry);
	}
	return out;
}

/** Parse and validate the allowlist file. Returns the raw entry list. */
async function loadAllowlistRaw(path: string): Promise<AllowlistEntry[]> {
	const raw = yaml.parse(await readFile(path, 'utf-8')) as AllowlistFile | null;
	return raw?.entries ?? [];
}

/** Allowlist as a Set of accepted command tokens. */
async function loadAllowlistTokens(path: string): Promise<Set<string>> {
	const entries = await loadAllowlistRaw(path);
	return new Set(entries.map((e) => e.command));
}

describe('command documentation coverage', () => {
	it('every catalog command (admin + non-admin) is documented', async () => {
		const apps = await discoverApps(REPO_ROOT);
		const indexed = await buildIndexedContent(apps);
		const allowlist = await loadAllowlistTokens(ALLOWLIST_PATH);

		const adminCatalog = await getEffectiveCommandCatalog(
			'admin1',
			buildLiveDeps({ admin: true, apps }),
		);
		const userCatalog = await getEffectiveCommandCatalog(
			'user1',
			buildLiveDeps({ admin: false, apps }),
		);
		const combined = dedupeByCanonical([...adminCatalog, ...userCatalog]);

		const missing: string[] = [];
		for (const entry of combined) {
			const required = [entry.canonical, ...entry.aliases];
			for (const token of required) {
				if (tokenMatch(indexed, token)) continue;
				if (allowlist.has(token)) continue;
				missing.push(token);
			}
		}
		expect(missing, `Undocumented commands: ${missing.join(', ')}`).toEqual([]);
	});

	it('allowlist contains no orphan entries', async () => {
		const apps = await discoverApps(REPO_ROOT);
		const allowlist = await loadAllowlistTokens(ALLOWLIST_PATH);
		const adminCatalog = await getEffectiveCommandCatalog(
			'admin1',
			buildLiveDeps({ admin: true, apps }),
		);
		const userCatalog = await getEffectiveCommandCatalog(
			'user1',
			buildLiveDeps({ admin: false, apps }),
		);

		const known = new Set<string>();
		for (const entry of [...adminCatalog, ...userCatalog]) {
			known.add(entry.canonical);
			for (const alias of entry.aliases) known.add(alias);
		}

		const orphans = [...allowlist].filter((cmd) => !known.has(cmd));
		expect(orphans, `Orphan allowlist entries: ${orphans.join(', ')}`).toEqual([]);
	});

	it('allowlist contains no expired entries', async () => {
		const entries = await loadAllowlistRaw(ALLOWLIST_PATH);
		const now = new Date();
		const expired = entries.filter((e) => {
			if (!e.expires) return false;
			const exp = new Date(e.expires);
			return !Number.isNaN(exp.getTime()) && exp <= now;
		});
		expect(
			expired.map((e) => e.command),
			'Expired allowlist entries',
		).toEqual([]);
	});

	it('rejects allowlist entries missing required fields', async () => {
		const entries = await loadAllowlistRaw(ALLOWLIST_PATH);
		for (const entry of entries) {
			expect(
				typeof entry.command === 'string' && entry.command.length > 0,
				'command required',
			).toBe(true);
			expect(
				typeof entry.reason === 'string' && entry.reason.length > 0,
				`reason required for ${entry.command}`,
			).toBe(true);
			expect(
				typeof entry.owner === 'string' && entry.owner.length > 0,
				`owner required for ${entry.command}`,
			).toBe(true);
		}
	});
});
