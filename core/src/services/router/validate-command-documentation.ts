/**
 * Pure helper shared by:
 *   - `command-documentation.test.ts` (Batch 1F build-failing gate)
 *   - `compose-runtime.ts` (Batch 1G boot-time soft warning)
 *
 * Returns a structured `DocCoverageResult` describing every catalog command
 * missing from indexed help content, every orphan allowlist entry (command
 * no longer in the catalog), and every expired allowlist entry. `logDocCoverageWarnings`
 * emits Pino warnings for each non-empty bucket; callers decide whether to
 * fail the test or merely warn.
 *
 * Drift guard: the result shape is consumed verbatim by the 1F test's
 * assertions — `missing` items carry `{ command, aliasOf? }` so the test can
 * report aliases distinctly from canonicals. Keep this shape stable.
 */
import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import * as yaml from 'yaml';
import type { KnowledgeEntry } from '../../types/app-knowledge.js';
import {
	type CommandCatalogDeps,
	type CommandCatalogEntry,
	getEffectiveCommandCatalog,
} from './command-catalog.js';

/** A single missing-doc record. `aliasOf` is set when the missing token is an alias. */
export interface MissingCommandRecord {
	command: string;
	aliasOf?: string;
}

/** Structured result of a doc-coverage check. All buckets are empty when coverage is clean. */
export interface DocCoverageResult {
	/** Commands (canonical or alias) absent from indexed content AND not in the allowlist. */
	missing: MissingCommandRecord[];
	/** Allowlist tokens that no longer correspond to any catalog command. */
	orphanAllowlist: string[];
	/** Allowlist entries with `expires` in the past. */
	expiredAllowlist: string[];
}

/** Schema for the YAML allowlist. Loader validates required fields lazily. */
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
 * Word-bounded, case-insensitive match for a literal slash command token.
 *
 * Prevents `/note` matching `footnote`. Mirrors the test's helper so the boot
 * warning and the test agree on what "documented" means.
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

/** Parse the allowlist file. Returns `[]` when missing or empty. */
async function loadAllowlistRaw(path: string): Promise<AllowlistEntry[]> {
	try {
		const raw = (await readFile(path, 'utf-8')).toString();
		const parsed = yaml.parse(raw) as AllowlistFile | null;
		return parsed?.entries ?? [];
	} catch {
		return [];
	}
}

/**
 * Inputs for `validateCommandDocumentation`. `indexedEntries` is the
 * truncated content the chatbot's runtime search sees; pass the result of
 * `AppKnowledgeBase.getEntries()` or `loadIndexedEntries(...)`.
 *
 * `catalogDeps` is the same shape `getEffectiveCommandCatalog` consumes.
 * The boot-time caller forces `isAppEnabledForUser: () => true` and
 * `isUserAdmin: () => true` so coverage reflects every command that could
 * ever be dispatched (Codex correction I4).
 */
export interface ValidateCommandDocumentationOptions {
	indexedEntries: KnowledgeEntry[];
	catalogDeps: CommandCatalogDeps;
	allowlistPath: string;
	/**
	 * Synthetic user id to pass to `getEffectiveCommandCatalog`. The catalog
	 * is queried twice (admin + non-admin) and merged, so this id need not
	 * be a real user. Defaults to `<boot>`.
	 */
	bootUserId?: string;
}

/**
 * Compute doc coverage across the union of admin + non-admin catalog views.
 *
 * Implementation mirrors the 1F test's algorithm so the boot-time warning
 * and the build-failing test never diverge. The 1F test is refactored to
 * call this helper (Step 2).
 */
export async function validateCommandDocumentation(
	opts: ValidateCommandDocumentationOptions,
): Promise<DocCoverageResult> {
	const bootUserId = opts.bootUserId ?? '<boot>';
	const indexed = opts.indexedEntries.map((e) => e.content).join('\n');

	// Force admin=true and admin=false to capture every command — `/invite`
	// is admin-only, but we still need to document it.
	const adminCatalog = await getEffectiveCommandCatalog(bootUserId, {
		...opts.catalogDeps,
		isUserAdmin: () => true,
	});
	const userCatalog = await getEffectiveCommandCatalog(bootUserId, {
		...opts.catalogDeps,
		isUserAdmin: () => false,
	});
	const combined = dedupeByCanonical([...adminCatalog, ...userCatalog]);

	const allowlistRaw = await loadAllowlistRaw(opts.allowlistPath);
	const allowlistTokens = new Set(allowlistRaw.map((e) => e.command));

	// Missing buckets: walk every canonical + alias; record as missing iff
	// (a) not present in indexed content, AND (b) not in the allowlist.
	const missing: MissingCommandRecord[] = [];
	for (const entry of combined) {
		if (!tokenMatch(indexed, entry.canonical) && !allowlistTokens.has(entry.canonical)) {
			missing.push({ command: entry.canonical });
		}
		for (const alias of entry.aliases) {
			if (!tokenMatch(indexed, alias) && !allowlistTokens.has(alias)) {
				missing.push({ command: alias, aliasOf: entry.canonical });
			}
		}
	}

	// Orphan allowlist entries: tokens in the allowlist that no longer
	// correspond to any catalog command (canonical or alias).
	const known = new Set<string>();
	for (const entry of combined) {
		known.add(entry.canonical);
		for (const alias of entry.aliases) known.add(alias);
	}
	const orphanAllowlist = [...allowlistTokens].filter((cmd) => !known.has(cmd));

	// Expired allowlist entries: `expires` is a parseable ISO date in the past.
	const now = new Date();
	const expiredAllowlist = allowlistRaw
		.filter((e) => {
			if (!e.expires) return false;
			const exp = new Date(e.expires);
			return !Number.isNaN(exp.getTime()) && exp <= now;
		})
		.map((e) => e.command);

	return { missing, orphanAllowlist, expiredAllowlist };
}

/**
 * Emit structured Pino warnings for any non-empty coverage bucket. Mirrors
 * existing compose-runtime warnings (object-first, then message string).
 *
 * Never throws. Caller — the boot path — must not refuse to boot on doc gaps;
 * this is a soft safety net for tests bypassed or docs deleted post-merge.
 */
export function logDocCoverageWarnings(result: DocCoverageResult, logger: Logger): void {
	if (result.missing.length > 0) {
		logger.warn(
			{
				missing: result.missing.map((m) => m.command),
				count: result.missing.length,
			},
			'Command documentation coverage gap detected; chatbot KB will not surface these commands',
		);
	}
	if (result.orphanAllowlist.length > 0) {
		logger.warn(
			{ orphans: result.orphanAllowlist },
			'undocumented-commands.yaml contains entries for commands no longer in the catalog',
		);
	}
	if (result.expiredAllowlist.length > 0) {
		logger.warn(
			{ expired: result.expiredAllowlist },
			'undocumented-commands.yaml entries have expired',
		);
	}
}
