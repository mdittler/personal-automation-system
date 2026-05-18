/**
 * Build-failing doc-coverage gate: every effective router command must appear
 * in the AppKnowledgeBase-indexed help content (the same 2000-char-truncated
 * slice the chatbot sees). Aliases each required independently. The allowlist
 * at `core/config/undocumented-commands.yaml` permits temporary exceptions
 * with required fields and stale-entry detection.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeEntry } from '../../../types/app-knowledge.js';
import { readYamlFile } from '../../../utils/yaml.js';
import { loadIndexedEntries } from '../../app-knowledge/index.js';
import type { RegisteredApp } from '../../app-registry/index.js';
import type { CommandCatalogDeps } from '../command-catalog.js';
import {
	logDocCoverageWarnings,
	validateCommandDocumentation,
} from '../validate-command-documentation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__ → router → services → src → core → <repo root>
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const INFRA_DOCS = join(REPO_ROOT, 'core', 'docs', 'help');
const APPS_DIR = join(REPO_ROOT, 'apps');
const ALLOWLIST_PATH = join(REPO_ROOT, 'core', 'config', 'undocumented-commands.yaml');

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
		const manifest = await readYamlFile<DiscoveredApp['manifest']>(
			join(appDir, 'manifest.yaml'),
		);
		const appId = manifest?.app?.id;
		if (!manifest || typeof appId !== 'string' || appId.length === 0) continue;
		out.push({ appId, appDir, manifest });
	}
	return out;
}

function buildLiveDeps(opts: { apps: DiscoveredApp[] }): CommandCatalogDeps {
	const registered: RegisteredApp[] = opts.apps.map(
		(a) =>
			({
				manifest: a.manifest,
				appDir: a.appDir,
				module: undefined as never,
			}) as unknown as RegisteredApp,
	);
	return {
		registry: { getAll: () => registered },
		isUserAdmin: () => true,
		isAppEnabledForUser: () => true,
		conversationServiceWired: true,
		spaceServiceWired: true,
		inviteServiceWired: true,
	};
}

async function buildIndexedEntries(apps: DiscoveredApp[]): Promise<KnowledgeEntry[]> {
	const indexedApps = apps.map((a) => ({ appId: a.appId, appDir: a.appDir }));
	return loadIndexedEntries({
		infraDocsDir: INFRA_DOCS,
		apps: indexedApps,
	});
}

function makeStubLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
	const warn = vi.fn();
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

	it('production allowlist has no malformed entries', async () => {
		const apps = await discoverApps(REPO_ROOT);
		const result = await validateCommandDocumentation({
			indexedEntries: await buildIndexedEntries(apps),
			catalogDeps: buildLiveDeps({ apps }),
			allowlistPath: ALLOWLIST_PATH,
		});
		expect(
			result.malformedAllowlist,
			`Malformed allowlist entries: ${result.malformedAllowlist.join(', ')}`,
		).toEqual([]);
	});
});

describe('allowlist fixture validation', () => {
	const FIXTURES_DIR = join(REPO_ROOT, 'core', 'src', 'services', 'router', '__tests__', 'fixtures');
	const fixtureDeps = (): CommandCatalogDeps => ({
		registry: { getAll: () => [] },
		isUserAdmin: () => true,
		isAppEnabledForUser: () => true,
		conversationServiceWired: true,
		spaceServiceWired: true,
		inviteServiceWired: true,
	});
	// Indexed content that covers every catalog command so coverage gaps don't drown the signal.
	const exhaustiveIndexed = [
		{
			appId: 'fixture',
			source: 'fake.md',
			content:
				'/help /start /space /invite /ask /edit /notes /newchat /reset /title /recall ' +
				'/refreshmemory /refresh-memory /flushmemory /flush-memory /settings',
		},
	];

	it('flags entries missing required reason or owner fields', async () => {
		const result = await validateCommandDocumentation({
			indexedEntries: exhaustiveIndexed,
			catalogDeps: fixtureDeps(),
			allowlistPath: join(FIXTURES_DIR, 'allowlist-missing-fields.yaml'),
		});
		expect(result.malformedAllowlist).toEqual(
			expect.arrayContaining(['/no-reason', '/no-owner', '<missing command>']),
		);
	});

	it('flags orphan entries — command no longer in the catalog', async () => {
		const result = await validateCommandDocumentation({
			indexedEntries: exhaustiveIndexed,
			catalogDeps: fixtureDeps(),
			allowlistPath: join(FIXTURES_DIR, 'allowlist-orphan.yaml'),
		});
		expect(result.orphanAllowlist).toEqual(['/totally-gone']);
		expect(result.malformedAllowlist).toEqual([]);
	});

	it('flags expired entries', async () => {
		const result = await validateCommandDocumentation({
			indexedEntries: exhaustiveIndexed,
			catalogDeps: fixtureDeps(),
			allowlistPath: join(FIXTURES_DIR, 'allowlist-expired.yaml'),
		});
		expect(result.expiredAllowlist).toEqual(['/help']);
	});

	it('treats malformed root (non-list entries:) as zero valid entries plus a malformed marker', async () => {
		const result = await validateCommandDocumentation({
			indexedEntries: [
				{ appId: 'fixture', source: 'sparse.md', content: '/help /start' },
			],
			catalogDeps: fixtureDeps(),
			allowlistPath: join(FIXTURES_DIR, 'allowlist-malformed-root.yaml'),
		});
		expect(result.malformedAllowlist).toEqual(['<root entries is not a list>']);
		// Allowlist provides no valid entries → undocumented commands not whitelisted.
		expect(result.missing.length).toBeGreaterThan(0);
	});
});

describe('boot-time soft warning integration', () => {
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

	// readYamlFile returns null when missing, so the loader yields [].
	const ALLOWLIST_PATH_EMPTY = '/tmp/nonexistent-undocumented-commands.yaml';

	it('logs a warning when a catalog command lacks docs at boot', async () => {
		const { logger, warn } = makeStubLogger();
		const result = await validateCommandDocumentation({
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
