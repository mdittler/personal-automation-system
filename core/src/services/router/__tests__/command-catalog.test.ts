/**
 * Tests for `getEffectiveCommandCatalog`.
 *
 * The catalog is the single source of truth for every slash command the Router
 * would actually dispatch for a given user. Downstream consumers (help output,
 * `/ask` system prompt, doc-coverage checks, boot warnings) all read from it.
 *
 * Critical drift guard: `ManifestCommand` uses `name`, NOT `command`. Tests
 * intentionally exercise the production manifest shape — and one case loads
 * `apps/notes/manifest.yaml` off disk so a fixture using `{command:}` would
 * not silently pass.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readYamlFile } from '../../../utils/yaml.js';
import type { RegisteredApp } from '../../app-registry/index.js';
import { type CommandCatalogDeps, getEffectiveCommandCatalog } from '../command-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..', '..', '..');

function buildDeps(opts: Partial<CommandCatalogDeps> = {}): CommandCatalogDeps {
	return {
		registry: { getAll: () => [] },
		isUserAdmin: () => false,
		isAppEnabledForUser: () => true,
		conversationServiceWired: true,
		...opts,
	};
}

/**
 * Load a real manifest off disk and adapt it into a fake registry that returns
 * the production `RegisteredApp[]` shape. This guards against drift between
 * the manifest shape used in fixtures (e.g. `{command:}`) and the real one
 * (`{name:}`).
 */
async function loadRealRegistryFixture(appRelDir: string): Promise<CommandCatalogDeps['registry']> {
	const manifestPath = join(repoRoot, appRelDir, 'manifest.yaml');
	const manifest = await readYamlFile(manifestPath);
	if (!manifest) {
		throw new Error(`Could not load manifest at ${manifestPath}`);
	}
	const fake = { manifest } as unknown as RegisteredApp;
	return { getAll: () => [fake] };
}

describe('getEffectiveCommandCatalog', () => {
	it('includes all BUILTIN_COMMAND_NAMES for a regular user', async () => {
		const catalog = await getEffectiveCommandCatalog('user1', buildDeps());
		const names = catalog.map((c) => c.canonical);
		expect(names).toEqual(
			expect.arrayContaining([
				'/ask',
				'/edit',
				'/notes',
				'/newchat',
				'/title',
				'/recall',
				'/refreshmemory',
				'/flushmemory',
				'/settings',
			]),
		);
	});

	it('includes /help, /space, /start for every user (directly-handled, not in BUILTIN_COMMAND_NAMES)', async () => {
		const catalog = await getEffectiveCommandCatalog('user1', buildDeps());
		const names = catalog.map((c) => c.canonical);
		expect(names).toEqual(expect.arrayContaining(['/help', '/space', '/start']));
	});

	it('hides /invite from non-admins', async () => {
		const catalog = await getEffectiveCommandCatalog(
			'user1',
			buildDeps({ isUserAdmin: () => false }),
		);
		expect(catalog.find((c) => c.canonical === '/invite')).toBeUndefined();
	});

	it('shows /invite to admins', async () => {
		const catalog = await getEffectiveCommandCatalog(
			'user1',
			buildDeps({ isUserAdmin: () => true }),
		);
		const invite = catalog.find((c) => c.canonical === '/invite');
		expect(invite).toBeDefined();
		expect(invite!.adminOnly).toBe(true);
	});

	it('groups aliases (newchat/reset, refreshmemory/refresh-memory, flushmemory/flush-memory)', async () => {
		const catalog = await getEffectiveCommandCatalog('user1', buildDeps());
		const refresh = catalog.find((c) => c.canonical === '/refreshmemory');
		expect(refresh!.aliases).toEqual(expect.arrayContaining(['/refresh-memory']));
		const newchat = catalog.find((c) => c.canonical === '/newchat');
		expect(newchat!.aliases).toEqual(expect.arrayContaining(['/reset']));
		const flush = catalog.find((c) => c.canonical === '/flushmemory');
		expect(flush!.aliases).toEqual(expect.arrayContaining(['/flush-memory']));
	});

	it('omits service-gated commands when conversation service is not wired', async () => {
		const catalog = await getEffectiveCommandCatalog(
			'user1',
			buildDeps({ conversationServiceWired: false }),
		);
		expect(catalog.find((c) => c.canonical === '/ask')).toBeUndefined();
		expect(catalog.find((c) => c.canonical === '/edit')).toBeUndefined();
		// /help and /space are not service-gated
		expect(catalog.find((c) => c.canonical === '/help')).toBeDefined();
		expect(catalog.find((c) => c.canonical === '/space')).toBeDefined();
	});

	it('includes app-manifest commands for enabled apps and excludes them for disabled apps', async () => {
		const fakeApp = {
			manifest: {
				app: { id: 'food' },
				capabilities: {
					messages: {
						commands: [{ name: '/recipes', description: 'List recipes' }],
					},
				},
			},
		} as unknown as RegisteredApp;

		const enabledDeps = buildDeps({
			registry: { getAll: () => [fakeApp] },
			isAppEnabledForUser: (_userId, appId) => appId === 'food',
		});
		const catalog = await getEffectiveCommandCatalog('user1', enabledDeps);
		expect(catalog.find((c) => c.canonical === '/recipes')).toBeDefined();

		const disabledDeps = buildDeps({
			registry: { getAll: () => [fakeApp] },
			isAppEnabledForUser: () => false,
		});
		const catalog2 = await getEffectiveCommandCatalog('user1', disabledDeps);
		expect(catalog2.find((c) => c.canonical === '/recipes')).toBeUndefined();
	});

	it('discovers production manifest commands (Notes /note must be present)', async () => {
		// Load the real apps/notes/manifest.yaml off disk via the same registry-shape
		// adapter the runtime uses. This guards against the test-vs-production
		// shape drift Codex flagged: a fixture using {command:} would parse fine
		// but never match production {name:}.
		const fakeRegistry = await loadRealRegistryFixture('apps/notes');
		const deps = buildDeps({ registry: fakeRegistry });
		const catalog = await getEffectiveCommandCatalog('user1', deps);
		expect(catalog.find((c) => c.canonical === '/note')).toBeDefined();
	});

	it('catalog entries carry description and source labels', async () => {
		const catalog = await getEffectiveCommandCatalog('user1', buildDeps());
		const help = catalog.find((c) => c.canonical === '/help');
		expect(help!.description).toMatch(/.+/); // non-empty
		// /help, /start, /space, /invite are direct-handled (outside BUILTIN_COMMAND_NAMES);
		// their source label is 'direct' to distinguish from the service-gated conversation builtins.
		expect(help!.source).toBe('direct');

		// Built-in conversation commands carry the 'builtin' label
		const ask = catalog.find((c) => c.canonical === '/ask');
		expect(ask!.source).toBe('builtin');
	});

	it('app-manifest commands carry source:"app" and appId', async () => {
		const fakeApp = {
			manifest: {
				app: { id: 'food' },
				capabilities: {
					messages: {
						commands: [
							{
								name: '/recipes',
								description: 'List recipes',
								args: ['filter'],
							},
						],
					},
				},
			},
		} as unknown as RegisteredApp;
		const deps = buildDeps({ registry: { getAll: () => [fakeApp] } });
		const catalog = await getEffectiveCommandCatalog('user1', deps);
		const recipes = catalog.find((c) => c.canonical === '/recipes');
		expect(recipes).toBeDefined();
		expect(recipes!.source).toBe('app');
		expect(recipes!.appId).toBe('food');
		expect(recipes!.argSignature).toBe('<filter>');
	});
});
