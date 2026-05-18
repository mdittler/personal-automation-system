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

interface AllowlistEntry {
	command: string;
	reason: string;
	owner: string;
	expires?: string;
}

interface AllowlistFile {
	entries?: AllowlistEntry[];
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
	};
}

async function buildIndexedEntries(apps: DiscoveredApp[]): Promise<KnowledgeEntry[]> {
	const indexedApps = apps.map((a) => ({ appId: a.appId, appDir: a.appDir }));
	return loadIndexedEntries({
		infraDocsDir: INFRA_DOCS,
		apps: indexedApps,
	});
}

async function loadAllowlistRaw(path: string): Promise<AllowlistEntry[]> {
	const parsed = await readYamlFile<AllowlistFile>(path);
	return parsed?.entries ?? [];
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
