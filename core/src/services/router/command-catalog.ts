/**
 * Per-user effective command catalog.
 *
 * Returns every slash command the Router would actually dispatch for a given
 * user — built-in conversation commands, directly-handled commands (/help,
 * /start, /space, /invite), admin-gated entries, and app-manifest commands
 * filtered by per-user app toggles. Aliases (e.g. /newchat <-> /reset) are
 * collapsed into a single entry per canonical command.
 *
 * Single source of truth for:
 *   - `/help` output (Batch 1B+)
 *   - `/ask` system-prompt injection (Batch 1B)
 *   - Doc-coverage test (Batch 1F)
 *   - Boot-time soft warning (Batch 1G)
 *
 * Drift guard: `ManifestCommand` from `core/src/types/manifest.ts` uses the
 * `name` field (e.g. `/note`), NOT `command`. The dependency type and the
 * implementation below must match the production manifest shape exactly.
 *
 * `BUILTIN_COMMAND_NAMES` lives here (instead of `router/index.ts`) so this
 * module has no cyclic dependency on the Router class. `router/index.ts`
 * re-exports it for backwards compatibility.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManifestCommand } from '../../types/manifest.js';
import { readYamlFile } from '../../utils/yaml.js';
import type { RegisteredApp } from '../app-registry/index.js';

/**
 * Built-in command names the Router handles directly via the
 * ConversationService short-circuit (bypassing app manifest dispatch).
 *
 * Includes every alias token; downstream consumers should canonicalize via
 * `ALIAS_GROUPS` before deduping for display.
 */
export const BUILTIN_COMMAND_NAMES = new Set([
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
]);

/** A single command entry as it appears in the effective catalog. */
export interface CommandCatalogEntry {
	/** Canonical command name with leading slash, e.g. `/refreshmemory`. */
	canonical: string;
	/** Alias names (excluding canonical), e.g. `['/refresh-memory']`. */
	aliases: string[];
	/** Human-readable description (non-empty). */
	description: string;
	/** True iff the command is gated to platform admins. */
	adminOnly: boolean;
	/**
	 * Where this command comes from:
	 *   - `'direct'`  → router dispatches outside `BUILTIN_COMMAND_NAMES` (/help, /start, /space, /invite)
	 *   - `'builtin'` → ConversationService short-circuit (/ask, /edit, ...)
	 *   - `'app'`     → declared by an installed app's manifest
	 */
	source: 'builtin' | 'direct' | 'app';
	/** App id when `source === 'app'`. Undefined otherwise. */
	appId?: string;
	/** Argument signature, e.g. `'<name>'` or `'<filter> <count>'`. Undefined when no args. */
	argSignature?: string;
}

/**
 * Dependencies for the catalog helper. Shape mirrors the production
 * `AppRegistry.getAll(): RegisteredApp[]` return type so test fakes can plug
 * in real manifest data without TypeScript drift.
 *
 * NOTE: `registry.getAll()` is typed via the real `RegisteredApp` shape (the
 * same type the production registry returns). This guards against
 * `name` vs `command` drift: a hand-crafted fixture that declares `command:`
 * would fail to typecheck against `ManifestCommand`.
 */
export interface CommandCatalogDeps {
	registry: { getAll(): RegisteredApp[] };
	/** Returns true iff the given user has the platform-admin flag. */
	isUserAdmin(userId: string): boolean | Promise<boolean>;
	/** Returns true iff the given app is enabled for the given user. */
	isAppEnabledForUser(userId: string, appId: string): boolean | Promise<boolean>;
	/**
	 * True iff `ConversationService` is wired in this process. When false, the
	 * router would never dispatch service-gated builtins (/ask, /edit, ...),
	 * so the catalog omits them.
	 */
	conversationServiceWired: boolean;
}

/**
 * Alias groupings — canonical command → aliases. Mirrors the
 * `parsed.command === '/x' || parsed.command === '/y'` arms in
 * `router/index.ts::handleCommand`.
 *
 * Iteration order is insertion order; entries appear in the catalog in this
 * order after directly-handled commands.
 */
const ALIAS_GROUPS: Record<string, string[]> = {
	'/newchat': ['/reset'],
	'/refreshmemory': ['/refresh-memory'],
	'/flushmemory': ['/flush-memory'],
};

/** Reverse lookup: alias token → canonical. Built lazily for canonicalize(). */
const ALIAS_TO_CANONICAL: Map<string, string> = (() => {
	const m = new Map<string, string>();
	for (const [canonical, aliases] of Object.entries(ALIAS_GROUPS)) {
		for (const alias of aliases) {
			m.set(alias, canonical);
		}
	}
	return m;
})();

function canonicalize(name: string): string {
	return ALIAS_TO_CANONICAL.get(name) ?? name;
}

/**
 * Directly-handled commands the Router dispatches via dedicated branches
 * outside `BUILTIN_COMMAND_NAMES`:
 *   - `/help`   → `Router::sendHelp` (router/index.ts:600)
 *   - `/start`  → onboarding entry (router/index.ts:607)
 *   - `/space`  → `Router::handleSpaceCommand` (router/index.ts:367)
 *   - `/invite` → `Router::handleInviteCommand` (router/index.ts:372, 1274)
 *
 * Source label is `'direct'` to distinguish them from the service-gated
 * conversation builtins (which carry `'builtin'`).
 */
const DIRECT_HANDLED: ReadonlyArray<{
	canonical: string;
	description: string;
	adminOnly: boolean;
	argSignature?: string;
}> = [
	{
		canonical: '/help',
		description: 'List available commands',
		adminOnly: false,
	},
	{
		canonical: '/start',
		description: 'Onboarding entry (also redeems invite codes)',
		adminOnly: false,
		argSignature: '[invite-code]',
	},
	{
		canonical: '/space',
		// Subcommand hints are embedded in the description so they surface in
		// both the rendered `/help` output and the system-prompt injection.
		// Full subcommand reference: `/space`, `/space <id>`, `/space off`,
		// `/space create <id> <name>`, `/space members`, `/space add`,
		// `/space remove`.
		description:
			'Manage shared data spaces; subcommands: /space, /space <id>, /space off, /space create <id> <name>',
		adminOnly: false,
	},
	{
		canonical: '/invite',
		description: 'Generate an invite code for a new user',
		adminOnly: true,
		argSignature: '<name>',
	},
];

/** Descriptions for the service-gated conversation builtins. */
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
	'/ask': 'Ask PAS a question (forces app-aware mode)',
	'/edit': 'LLM-assisted file edit',
	'/notes': 'Toggle daily-notes logging',
	'/newchat': 'Start a new conversation',
	'/title': 'Show or set the current session title',
	'/recall': 'Search past conversations',
	'/refreshmemory': 'Rebuild memory snapshot from current state',
	'/flushmemory': 'Save a summary of this session to long-term memory',
	'/settings': 'View or change settings inline',
};

/**
 * Compute the per-user effective command catalog.
 *
 * Order:
 *   1. Directly-handled commands (filtered by `adminOnly`)
 *   2. Service-gated conversation builtins (when wired)
 *   3. App-manifest commands (filtered by `isAppEnabledForUser`)
 *
 * Aliases are collapsed into a single entry per canonical command. Each entry
 * carries a `source` label so downstream renderers (help, prompt, doc-cov)
 * can group/style accordingly.
 */
export async function getEffectiveCommandCatalog(
	userId: string,
	deps: CommandCatalogDeps,
): Promise<CommandCatalogEntry[]> {
	const isAdmin = await deps.isUserAdmin(userId);
	const out: CommandCatalogEntry[] = [];

	// 1. Directly-handled commands.
	for (const entry of DIRECT_HANDLED) {
		if (entry.adminOnly && !isAdmin) continue;
		out.push({
			canonical: entry.canonical,
			aliases: [],
			description: entry.description,
			adminOnly: entry.adminOnly,
			source: 'direct',
			argSignature: entry.argSignature,
		});
	}

	// 2. Service-gated conversation builtins.
	if (deps.conversationServiceWired) {
		const seenCanonical = new Set<string>();
		for (const name of BUILTIN_COMMAND_NAMES) {
			const canonical = canonicalize(name);
			if (seenCanonical.has(canonical)) continue;
			seenCanonical.add(canonical);
			out.push({
				canonical,
				aliases: [...(ALIAS_GROUPS[canonical] ?? [])],
				description: BUILTIN_DESCRIPTIONS[canonical] ?? canonical,
				adminOnly: false,
				source: 'builtin',
			});
		}
	}

	// 3. App-manifest commands, filtered by per-user app toggle.
	for (const app of deps.registry.getAll()) {
		const appId = app.manifest.app.id;
		const enabled = await deps.isAppEnabledForUser(userId, appId);
		if (!enabled) continue;
		const cmds = app.manifest.capabilities?.messages?.commands ?? [];
		for (const cmd of cmds) {
			out.push({
				canonical: cmd.name,
				aliases: [],
				description: cmd.description || cmd.name,
				adminOnly: false,
				source: 'app',
				appId,
				argSignature:
					cmd.args && cmd.args.length > 0 ? cmd.args.map((a) => `<${a}>`).join(' ') : undefined,
			});
		}
	}

	return out;
}

/**
 * A single shadow collision between an app's manifest command and either a
 * built-in command or another app's command. Surfaced by
 * `detectCommandShadowing()` and consumed by the shadowing test (build gate)
 * and the boot-time soft warning (Batch 1G).
 */
export interface ShadowCollision {
	/** Full command name including the leading slash (e.g. `/notes`). */
	command: string;
	/**
	 * `'builtin'` for collisions against `BUILTIN_COMMAND_NAMES` or the
	 * directly-handled set. `` `app:${appId}` `` for the first app that declared
	 * the same name when two apps collide.
	 */
	conflictWith: 'builtin' | `app:${string}`;
	/** The app id that introduced the colliding declaration. */
	detectedIn: string;
}

/**
 * Optional overrides for `detectCommandShadowing`. When omitted, builtins are
 * read from `BUILTIN_COMMAND_NAMES` + `DIRECT_HANDLED`, and manifests are
 * loaded off-disk via `loadAllManifests()`.
 *
 * Drift guard: `commands[].name` (NOT `command`) — must match the production
 * `ManifestCommand` shape from `core/src/types/manifest.ts`.
 */
export interface ShadowingOverrides {
	builtins: Set<string>;
	manifests: Array<{
		appId: string;
		commands: Array<Pick<ManifestCommand, 'name' | 'description'>>;
	}>;
}

/**
 * Detect command-name shadowing across the install: any app-manifest command
 * that collides with a built-in (or directly-handled) command, or with another
 * app's already-declared command, becomes a `ShadowCollision`.
 *
 * Called by the shadowing test (build gate). Returns `[]` when no collisions
 * exist. Overrides exist purely for the test's negative cases.
 */
export async function detectCommandShadowing(
	overrides?: ShadowingOverrides,
): Promise<ShadowCollision[]> {
	const builtins = overrides?.builtins ?? BUILTIN_COMMAND_NAMES;
	const directHandled = new Set(DIRECT_HANDLED.map((d) => d.canonical));
	const manifests = overrides?.manifests ?? (await loadAllManifests());

	const collisions: ShadowCollision[] = [];
	const firstSeen = new Map<string, string>(); // command -> appId

	for (const manifest of manifests) {
		for (const cmd of manifest.commands) {
			if (builtins.has(cmd.name) || directHandled.has(cmd.name)) {
				collisions.push({
					command: cmd.name,
					conflictWith: 'builtin',
					detectedIn: manifest.appId,
				});
			} else if (firstSeen.has(cmd.name)) {
				collisions.push({
					command: cmd.name,
					conflictWith: `app:${firstSeen.get(cmd.name)}`,
					detectedIn: manifest.appId,
				});
			} else {
				firstSeen.set(cmd.name, manifest.appId);
			}
		}
	}

	return collisions;
}

/**
 * Load every `apps/*\/manifest.yaml` off disk and reduce each to the
 * `{ appId, commands }` shape consumed by `detectCommandShadowing`.
 *
 * Path resolution is anchored to the repo root via `import.meta.url`
 * (ESM-only). Returns `[]` if no `apps/` directory exists.
 */
async function loadAllManifests(): Promise<Array<{ appId: string; commands: ManifestCommand[] }>> {
	const HERE = dirname(fileURLToPath(import.meta.url));
	// command-catalog.ts lives at core/src/services/router/; the repo root is
	// four levels up: router -> services -> src -> core -> <repo root>.
	const repoRoot = resolve(HERE, '..', '..', '..', '..');
	const appsDir = join(repoRoot, 'apps');

	let entries: string[];
	try {
		entries = await readdir(appsDir);
	} catch {
		return [];
	}

	const out: Array<{ appId: string; commands: ManifestCommand[] }> = [];
	for (const entry of entries) {
		const manifestPath = join(appsDir, entry, 'manifest.yaml');
		const manifest = await readYamlFile<AppManifestShape>(manifestPath);
		if (!manifest) continue;
		const appId = manifest.app?.id;
		if (typeof appId !== 'string' || appId.length === 0) continue;
		const commands = manifest.capabilities?.messages?.commands ?? [];
		out.push({ appId, commands });
	}
	return out;
}

/**
 * Local minimal manifest shape used by `loadAllManifests`. We deliberately do
 * not import the full `AppManifest` type here — `readYamlFile` returns
 * `unknown`-flavored data, and we only need the subset for collision detection.
 */
interface AppManifestShape {
	app?: { id?: string };
	capabilities?: { messages?: { commands?: ManifestCommand[] } };
}
