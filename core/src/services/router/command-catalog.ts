/**
 * Per-user effective command catalog: every slash command the Router would
 * dispatch for a given user — directly-handled, service-gated builtins,
 * and app-manifest commands filtered by per-user app toggles. Aliases are
 * collapsed into one entry per canonical.
 *
 * `BUILTIN_COMMAND_NAMES` lives here (not in `router/index.ts`) to avoid a
 * cyclic dependency with the Router class.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManifestCommand } from '../../types/manifest.js';
import { readYamlFile } from '../../utils/yaml.js';
import type { RegisteredApp } from '../app-registry/index.js';

/** Built-in commands served by the ConversationService short-circuit. Includes every alias token. */
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
 * `registry.getAll()` is typed via the production `RegisteredApp` shape so
 * fixtures cannot drift from `ManifestCommand.name`.
 *
 * Service-availability flags gate directly-handled and service-gated commands
 * so the catalog matches what the Router would actually dispatch:
 *   - `conversationServiceWired` → /ask, /edit, /notes, /newchat, /title, /recall, /refreshmemory, /flushmemory, /settings
 *   - `spaceServiceWired`        → /space
 *   - `inviteServiceWired`       → /invite (admin-only on top of this)
 */
export interface CommandCatalogDeps {
	registry: { getAll(): RegisteredApp[] };
	isUserAdmin(userId: string): boolean | Promise<boolean>;
	isAppEnabledForUser(userId: string, appId: string): boolean | Promise<boolean>;
	conversationServiceWired: boolean;
	spaceServiceWired: boolean;
	inviteServiceWired: boolean;
}

/** Canonical → alias tokens. Mirrors the alias arms in `router/index.ts::handleCommand`. */
const ALIAS_GROUPS: Record<string, string[]> = {
	'/newchat': ['/reset'],
	'/refreshmemory': ['/refresh-memory'],
	'/flushmemory': ['/flush-memory'],
};

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
 * Commands the Router dispatches via dedicated branches outside
 * `BUILTIN_COMMAND_NAMES` (/help, /start, /space, /invite). Subcommand hints
 * are embedded in descriptions so they reach both rendered `/help` output
 * and the system-prompt injection.
 */
type ServiceGate = 'always' | 'conversation' | 'space' | 'invite';

const DIRECT_HANDLED: ReadonlyArray<{
	canonical: string;
	description: string;
	adminOnly: boolean;
	argSignature?: string;
	requires: ServiceGate;
}> = [
	{
		canonical: '/help',
		description: 'List available commands',
		adminOnly: false,
		requires: 'always',
	},
	{
		canonical: '/start',
		description: 'Onboarding entry (also redeems invite codes)',
		adminOnly: false,
		argSignature: '[invite-code]',
		requires: 'always',
	},
	{
		canonical: '/space',
		description:
			'Manage shared data spaces; subcommands: /space, /space <id>, /space off, /space create <id> <name>',
		adminOnly: false,
		requires: 'space',
	},
	{
		canonical: '/invite',
		description: 'Generate an invite code for a new user',
		adminOnly: true,
		argSignature: '<name>',
		requires: 'invite',
	},
];

function serviceAvailable(gate: ServiceGate, deps: CommandCatalogDeps): boolean {
	switch (gate) {
		case 'always':
			return true;
		case 'conversation':
			return deps.conversationServiceWired;
		case 'space':
			return deps.spaceServiceWired;
		case 'invite':
			return deps.inviteServiceWired;
	}
}

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
 * Order: directly-handled (filtered by adminOnly) → service-gated builtins
 * (when wired) → app-manifest commands (filtered by per-user toggle).
 */
export async function getEffectiveCommandCatalog(
	userId: string,
	deps: CommandCatalogDeps,
): Promise<CommandCatalogEntry[]> {
	const isAdmin = await deps.isUserAdmin(userId);
	const out: CommandCatalogEntry[] = [];

	for (const entry of DIRECT_HANDLED) {
		if (entry.adminOnly && !isAdmin) continue;
		if (!serviceAvailable(entry.requires, deps)) continue;
		out.push({
			canonical: entry.canonical,
			aliases: [],
			description: entry.description,
			adminOnly: entry.adminOnly,
			source: 'direct',
			argSignature: entry.argSignature,
		});
	}

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
 * A collision between two declarations of the same slash command. `'builtin'`
 * covers `BUILTIN_COMMAND_NAMES` and the directly-handled set; `` `app:${appId}` ``
 * marks the first app to declare a name when two apps collide.
 */
export interface ShadowCollision {
	command: string;
	conflictWith: 'builtin' | `app:${string}`;
	detectedIn: string;
}

export interface ShadowingOverrides {
	builtins: Set<string>;
	manifests: Array<{
		appId: string;
		commands: Array<Pick<ManifestCommand, 'name' | 'description'>>;
	}>;
}

/** Returns `[]` when no collisions exist. Overrides exist purely for test negative cases. */
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
 * Read every `apps/*\/manifest.yaml` off disk into `{ appId, commands }`.
 * Returns `[]` if no `apps/` directory exists.
 */
export async function loadAllManifests(): Promise<
	Array<{ appId: string; commands: ManifestCommand[] }>
> {
	const HERE = dirname(fileURLToPath(import.meta.url));
	// router -> services -> src -> core -> <repo root>
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

interface AppManifestShape {
	app?: { id?: string };
	capabilities?: { messages?: { commands?: ManifestCommand[] } };
}
