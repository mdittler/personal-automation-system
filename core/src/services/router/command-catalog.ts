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
