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
 *
 * Helper-sharing (Batch 1G): the doc-coverage check lives in
 * `validate-command-documentation.ts` and is consumed by both this test
 * and `compose-runtime.ts`'s boot-time soft warning. The two cannot
 * diverge because they share the same `validateCommandDocumentation` call.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';
import type { KnowledgeEntry } from '../../../types/app-knowledge.js';
import { loadIndexedEntries } from '../../app-knowledge/index.js';
import type { RegisteredApp } from '../../app-registry/index.js';
import type { CommandCatalogDeps } from '../command-catalog.js';
import {
	logDocCoverageWarnings,
	validateCommandDocumentation,
} from '../validate-command-documentation.js';

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
 * - `isUserAdmin` is parameterized so the test (or the helper, when used
 *   directly) can build both admin and non-admin catalogs and union them.
 */
function buildLiveDeps(opts: { apps: DiscoveredApp[] }): CommandCatalogDeps {
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
		// Overridden by `validateCommandDocumentation` to build both admin and
		// non-admin catalogs. The value here is irrelevant.
		isUserAdmin: () => true,
		isAppEnabledForUser: () => true,
		conversationServiceWired: true,
	};
}

/** Load all indexed entries (production-truncated content) for live apps. */
async function buildIndexedEntries(apps: DiscoveredApp[]): Promise<KnowledgeEntry[]> {
	const indexedApps = apps.map((a) => ({ appId: a.appId, appDir: a.appDir }));
	return loadIndexedEntries({
		infraDocsDir: INFRA_DOCS,
		apps: indexedApps,
	});
}

/** Parse and validate the allowlist file. Returns the raw entry list. */
async function loadAllowlistRaw(path: string): Promise<AllowlistEntry[]> {
	const raw = yaml.parse(await readFile(path, 'utf-8')) as AllowlistFile | null;
	return raw?.entries ?? [];
}

/**
 * Make a stub Pino logger that records `.warn` calls. Used by the Batch 1G
 * integration test in this file to assert the warning shape without booting
 * the runtime.
 */
function makeStubLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
	const warn = vi.fn();
	// We only need warn for `logDocCoverageWarnings`; the other Logger methods
	// are typed as no-ops.
	const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
	return { logger, warn };
}

describe('command documentation coverage', () => {
	it('every catalog command (admin + non-admin) is documented', async () => {
		const apps = await discoverApps(REPO_ROOT);
		const result = await validateCommandDocumentation({
			indexedEntries: await buildIndexedEntries(apps),
			catalogDeps: buildLiveDeps({ apps }),
			allowlistPath: ALLOWLIST_PATH,
		});
		expect(
			result.missing,
			`Undocumented commands: ${result.missing.map((m) => m.command).join(', ')}`,
		).toEqual([]);
	});

	it('allowlist contains no orphan entries', async () => {
		const apps = await discoverApps(REPO_ROOT);
		const result = await validateCommandDocumentation({
			indexedEntries: await buildIndexedEntries(apps),
			catalogDeps: buildLiveDeps({ apps }),
			allowlistPath: ALLOWLIST_PATH,
		});
		expect(
			result.orphanAllowlist,
			`Orphan allowlist entries: ${result.orphanAllowlist.join(', ')}`,
		).toEqual([]);
	});

	it('allowlist contains no expired entries', async () => {
		const apps = await discoverApps(REPO_ROOT);
		const result = await validateCommandDocumentation({
			indexedEntries: await buildIndexedEntries(apps),
			catalogDeps: buildLiveDeps({ apps }),
			allowlistPath: ALLOWLIST_PATH,
		});
		expect(result.expiredAllowlist, 'Expired allowlist entries').toEqual([]);
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

describe('boot-time soft warning (Batch 1G integration)', () => {
	/**
	 * Fixture catalogDeps with a single registered app declaring known
	 * commands. `isAppEnabledForUser` is forced true so the helper's
	 * admin+non-admin union includes everything. The test asserts the
	 * warning fires when a catalog command is missing from indexed content.
	 */
	function fixtureDeps(appCommands: Array<{ name: string; description?: string }>) {
		const apps: DiscoveredApp[] = [
			{
				appId: 'fixture',
				appDir: '/tmp/fixture-app',
				manifest: {
					app: { id: 'fixture' },
					capabilities: { messages: { commands: appCommands } },
				},
			},
		];
		return buildLiveDeps({ apps });
	}

	// A throwaway allowlist path — fall-back loader returns [] when the file
	// can't be read, so this exercises the "no allowlist available" path.
	const ALLOWLIST_PATH_EMPTY = '/tmp/nonexistent-undocumented-commands.yaml';

	it('logs a warning when a catalog command lacks docs at boot', async () => {
		const { logger, warn } = makeStubLogger();
		const result = await validateCommandDocumentation({
			// Indexed content mentions no commands at all → every catalog token
			// will be missing. We pick `/madeupcmd` for the assertion.
			indexedEntries: [{ appId: 'fixture', source: 'fake.md', content: 'no command tokens here' }],
			catalogDeps: fixtureDeps([{ name: '/madeupcmd', description: 'fixture only' }]),
			allowlistPath: ALLOWLIST_PATH_EMPTY,
		});
		expect(result.missing.some((m) => m.command === '/madeupcmd')).toBe(true);

		logDocCoverageWarnings(result, logger);

		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ missing: expect.arrayContaining(['/madeupcmd']) }),
			expect.stringContaining('Command documentation coverage gap'),
		);
	});

	it('emits no warnings when coverage is clean', async () => {
		const { logger, warn } = makeStubLogger();
		// Indexed content mentions every command the catalog could produce:
		// the four DIRECT_HANDLED entries, every builtin canonical and alias,
		// and the fixture app command. Cheapest way to be exhaustive is to
		// list them all explicitly.
		const exhaustive = [
			'/help',
			'/start',
			'/space',
			'/invite',
			'/ask',
			'/edit',
			'/notes',
			'/newchat',
			'/reset',
			'/title',
			'/recall',
			'/refreshmemory',
			'/refresh-memory',
			'/flushmemory',
			'/flush-memory',
			'/settings',
			'/fixturecmd',
		].join(' ');
		const result = await validateCommandDocumentation({
			indexedEntries: [{ appId: 'fixture', source: 'fake.md', content: exhaustive }],
			catalogDeps: fixtureDeps([{ name: '/fixturecmd', description: 'fixture only' }]),
			allowlistPath: ALLOWLIST_PATH_EMPTY,
		});
		expect(result.missing).toEqual([]);
		expect(result.orphanAllowlist).toEqual([]);
		expect(result.expiredAllowlist).toEqual([]);

		logDocCoverageWarnings(result, logger);
		expect(warn).not.toHaveBeenCalled();
	});
});
