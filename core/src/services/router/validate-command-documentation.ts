/**
 * Compute doc-coverage of router commands against the AppKnowledgeBase-indexed
 * content. Used both as a build-failing test gate and as a boot-time soft
 * warning; the two paths share this single implementation so they cannot
 * disagree about what "documented" means.
 */
import type { Logger } from 'pino';
import type { KnowledgeEntry } from '../../types/app-knowledge.js';
import { readYamlFile } from '../../utils/yaml.js';
import { type CommandCatalogDeps, getEffectiveCommandCatalog } from './command-catalog.js';

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
	/**
	 * Allowlist entries that failed schema validation (missing required fields,
	 * malformed YAML, etc.). Reported with whichever rough identifier was
	 * recoverable (`command` if present, else a fallback marker).
	 */
	malformedAllowlist: string[];
}

interface AllowlistEntry {
	command: string;
	reason: string;
	owner: string;
	expires?: string;
}

interface AllowlistFile {
	entries?: unknown;
}

interface LoadedAllowlist {
	valid: AllowlistEntry[];
	malformed: string[];
}

/** Word-bounded, case-insensitive slash-token match — prevents `/note` matching `footnote`. */
function tokenMatch(haystack: string, command: string): boolean {
	const escaped = command.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
	const re = new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`, 'i');
	return re.test(haystack);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

async function loadAllowlist(path: string): Promise<LoadedAllowlist> {
	const parsed = await readYamlFile<AllowlistFile>(path);
	const rawEntries = parsed?.entries;
	if (rawEntries === undefined || rawEntries === null) {
		return { valid: [], malformed: [] };
	}
	if (!Array.isArray(rawEntries)) {
		return { valid: [], malformed: ['<root entries is not a list>'] };
	}
	const valid: AllowlistEntry[] = [];
	const malformed: string[] = [];
	for (const entry of rawEntries) {
		if (entry === null || typeof entry !== 'object') {
			malformed.push('<non-object entry>');
			continue;
		}
		const e = entry as Record<string, unknown>;
		const command = e.command;
		const reason = e.reason;
		const owner = e.owner;
		const expires = e.expires;
		if (!nonEmptyString(command) || !nonEmptyString(reason) || !nonEmptyString(owner)) {
			malformed.push(nonEmptyString(command) ? command : '<missing command>');
			continue;
		}
		if (expires !== undefined && !nonEmptyString(expires)) {
			malformed.push(command);
			continue;
		}
		valid.push({ command, reason, owner, expires: expires as string | undefined });
	}
	return { valid, malformed };
}

/**
 * `indexedEntries` is the truncated content the chatbot's runtime search sees
 * (`AppKnowledgeBase.getEntries()` or `loadIndexedEntries(...)`).
 *
 * `catalogDeps` is the same shape `getEffectiveCommandCatalog` consumes. The
 * boot-time caller forces `isAppEnabledForUser: () => true` so coverage covers
 * every command that could ever be dispatched.
 */
export interface ValidateCommandDocumentationOptions {
	indexedEntries: ReadonlyArray<KnowledgeEntry>;
	catalogDeps: CommandCatalogDeps;
	allowlistPath: string;
	/** Synthetic user id; defaults to `<boot>`. */
	bootUserId?: string;
}

export async function validateCommandDocumentation(
	opts: ValidateCommandDocumentationOptions,
): Promise<DocCoverageResult> {
	const bootUserId = opts.bootUserId ?? '<boot>';
	const indexed = opts.indexedEntries.map((e) => e.content).join('\n');

	// Build the admin view (every admin-gated command included) and use it for
	// coverage — `adminOnly` does not affect whether docs are required.
	const [combined, allowlist] = await Promise.all([
		getEffectiveCommandCatalog(bootUserId, {
			...opts.catalogDeps,
			isUserAdmin: () => true,
		}),
		loadAllowlist(opts.allowlistPath),
	]);
	const allowlistTokens = new Set(allowlist.valid.map((e) => e.command));

	const missing: MissingCommandRecord[] = [];
	const known = new Set<string>();
	for (const entry of combined) {
		known.add(entry.canonical);
		if (!tokenMatch(indexed, entry.canonical) && !allowlistTokens.has(entry.canonical)) {
			missing.push({ command: entry.canonical });
		}
		for (const alias of entry.aliases) {
			known.add(alias);
			if (!tokenMatch(indexed, alias) && !allowlistTokens.has(alias)) {
				missing.push({ command: alias, aliasOf: entry.canonical });
			}
		}
	}

	const orphanAllowlist = [...allowlistTokens].filter((cmd) => !known.has(cmd));

	const now = new Date();
	const expiredAllowlist = allowlist.valid
		.filter((e) => {
			if (!e.expires) return false;
			const exp = new Date(e.expires);
			return !Number.isNaN(exp.getTime()) && exp <= now;
		})
		.map((e) => e.command);

	return { missing, orphanAllowlist, expiredAllowlist, malformedAllowlist: allowlist.malformed };
}

/**
 * Emit structured Pino warnings for any non-empty coverage bucket. Never
 * throws — boot must not fail on a doc gap.
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
	if (result.malformedAllowlist.length > 0) {
		logger.warn(
			{ malformed: result.malformedAllowlist },
			'undocumented-commands.yaml entries failed schema validation',
		);
	}
}
