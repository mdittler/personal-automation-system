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
		spaceServiceWired: true,
		inviteServiceWired: true,
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
		// /help and /space are not conversation-gated
		expect(catalog.find((c) => c.canonical === '/help')).toBeDefined();
		expect(catalog.find((c) => c.canonical === '/space')).toBeDefined();
	});

	it('omits /space when SpaceService is not wired', async () => {
		const catalog = await getEffectiveCommandCatalog(
			'user1',
			buildDeps({ spaceServiceWired: false }),
		);
		expect(catalog.find((c) => c.canonical === '/space')).toBeUndefined();
		// /help still present
		expect(catalog.find((c) => c.canonical === '/help')).toBeDefined();
	});

	it('omits /invite when InviteService is not wired (even for admins)', async () => {
		const catalog = await getEffectiveCommandCatalog(
			'admin1',
			buildDeps({ isUserAdmin: () => true, inviteServiceWired: false }),
		);
		expect(catalog.find((c) => c.canonical === '/invite')).toBeUndefined();
	});

	it('shows /invite when InviteService is wired AND user is admin', async () => {
		const catalog = await getEffectiveCommandCatalog(
			'admin1',
			buildDeps({ isUserAdmin: () => true, inviteServiceWired: true }),
		);
		const invite = catalog.find((c) => c.canonical === '/invite');
		expect(invite).toBeDefined();
		expect(invite!.adminOnly).toBe(true);
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

	// --- Layer A augmentations (W1 traceability backfill, Phase 2) ---
	//
	// The cases below pin the *completeness* contract — the catalog must
	// include ALL AND ONLY the effective entries for a user — and the
	// whitespace-description boundary that the original W1 batch left open.

	describe('completeness — every reachable command is enumerated', () => {
		it('enumerates every directly-handled + builtin + enabled-app command with no extras', async () => {
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
			const catalog = await getEffectiveCommandCatalog(
				'admin1',
				buildDeps({
					isUserAdmin: () => true,
					registry: { getAll: () => [fakeApp] },
				}),
			);
			const names = catalog.map((c) => c.canonical).sort();
			// All-and-only: directly-handled (4, admin included) + builtins (9 canonicals) + app (1)
			expect(names).toEqual(
				[
					// directly-handled
					'/help',
					'/start',
					'/space',
					'/invite',
					// service-gated builtins (canonicals only — aliases grouped, not separate entries)
					'/ask',
					'/edit',
					'/notes',
					'/newchat',
					'/title',
					'/recall',
					'/refreshmemory',
					'/flushmemory',
					'/settings',
					// enabled app
					'/recipes',
				].sort(),
			);
			// No alias token leaks in as its own entry.
			expect(names).not.toContain('/reset');
			expect(names).not.toContain('/refresh-memory');
			expect(names).not.toContain('/flush-memory');
		});

		it('omits every conversation builtin AND keeps directly-handled when conversation service is unwired', async () => {
			const catalog = await getEffectiveCommandCatalog(
				'user1',
				buildDeps({ conversationServiceWired: false }),
			);
			const names = catalog.map((c) => c.canonical);
			for (const builtin of [
				'/ask',
				'/edit',
				'/notes',
				'/newchat',
				'/title',
				'/recall',
				'/refreshmemory',
				'/flushmemory',
				'/settings',
			]) {
				expect(names).not.toContain(builtin);
			}
			// directly-handled commands survive
			expect(names).toEqual(expect.arrayContaining(['/help', '/start', '/space']));
		});

		it('omits all three service-gated command families when no service is wired', async () => {
			const catalog = await getEffectiveCommandCatalog(
				'admin1',
				buildDeps({
					isUserAdmin: () => true,
					conversationServiceWired: false,
					spaceServiceWired: false,
					inviteServiceWired: false,
				}),
			);
			const names = catalog.map((c) => c.canonical);
			// /space (space-gated) and /invite (invite-gated) omitted; conversation builtins omitted
			expect(names).not.toContain('/space');
			expect(names).not.toContain('/invite');
			expect(names).not.toContain('/ask');
			// /help and /start are always-available
			expect(names).toEqual(expect.arrayContaining(['/help', '/start']));
		});
	});

	describe('whitespace-only description fallback', () => {
		// command-catalog.ts:215 uses `cmd.description || cmd.name`, which only
		// catches falsy values. A whitespace-only description ("   ") is truthy,
		// so it survives and later renders a dangling "- /cmd — " line in the
		// system prompt. The catalog must fall back to the canonical command
		// name when the description is empty or whitespace-only.
		it('falls back to the command name when an app description is whitespace-only', async () => {
			const fakeApp = {
				manifest: {
					app: { id: 'food' },
					capabilities: {
						messages: {
							commands: [{ name: '/blank', description: '   ' }],
						},
					},
				},
			} as unknown as RegisteredApp;
			const catalog = await getEffectiveCommandCatalog(
				'user1',
				buildDeps({ registry: { getAll: () => [fakeApp] } }),
			);
			const blank = catalog.find((c) => c.canonical === '/blank');
			expect(blank).toBeDefined();
			// Must NOT be a whitespace-only string — it should fall back to the name.
			expect(blank!.description.trim()).not.toBe('');
			expect(blank!.description).toBe('/blank');
		});

		it('falls back to the command name when an app description is an empty string', async () => {
			const fakeApp = {
				manifest: {
					app: { id: 'food' },
					capabilities: {
						messages: {
							commands: [{ name: '/empty', description: '' }],
						},
					},
				},
			} as unknown as RegisteredApp;
			const catalog = await getEffectiveCommandCatalog(
				'user1',
				buildDeps({ registry: { getAll: () => [fakeApp] } }),
			);
			const empty = catalog.find((c) => c.canonical === '/empty');
			expect(empty!.description).toBe('/empty');
		});

		it('preserves a genuine app description untouched', async () => {
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
			const catalog = await getEffectiveCommandCatalog(
				'user1',
				buildDeps({ registry: { getAll: () => [fakeApp] } }),
			);
			expect(catalog.find((c) => c.canonical === '/recipes')!.description).toBe('List recipes');
		});
	});
});
