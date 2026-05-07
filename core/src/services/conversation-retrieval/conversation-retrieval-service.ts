/**
 * ConversationRetrievalService — composes all data readers into a single
 * context snapshot for LLM prompt injection.
 *
 * Fan-out: all selected readers run in parallel via Promise.allSettled;
 * one failed reader does not prevent others from contributing. Per-category
 * character budgets prevent context bloat. The source policy (source-policy.ts)
 * is the authoritative allow/deny list — new data sources require an explicit
 * entry there before they can be wired here.
 */

import type { AlertDefinition } from '../../types/alert.js';
import type { AppKnowledgeBaseService, KnowledgeEntry } from '../../types/app-knowledge.js';
import type { AppInfo, AppMetadataService } from '../../types/app-metadata.js';
import type { AppLogger } from '../../types/app-module.js';
import type { SystemConfig } from '../../types/config.js';
import type {
	ContextEntry,
	ContextEntryKind,
	ContextStoreService,
} from '../../types/context-store.js';
import { CONTEXT_ENTRY_KINDS, DURABLE_KINDS } from '../../types/context-store.js';
import type { MemorySnapshot } from '../../types/conversation-session.js';
import type { DataQueryResult } from '../../types/data-query.js';
import type { DataQueryService } from '../../types/data-query.js';
import type { ReportDefinition } from '../../types/report.js';
import type { SystemInfoService } from '../../types/system-info.js';
import type { ChatTranscriptIndex, SearchResult } from '../chat-transcript-index/index.js';
import { CONTEXT_INTERNAL_BYPASS } from '../context-store/index.js';
import { getCurrentHouseholdId, getCurrentUserId } from '../context/request-context.js';
import type { InteractionContextService, InteractionEntry } from '../interaction-context/index.js';
import type { SettingsReader } from '../settings/settings-reader.js';
import { formatDataQueryContext } from '../conversation/data-query-context.js';
import { formatAlertLines, formatReportLines } from '../conversation/reports-alerts-format.js';
import { ConversationSystemInfoReader } from './conversation-system-info-reader.js';
import type { AllowedSourceCategory } from './source-policy.js';
import { chooseSources } from './source-selection.js';

// ─── Error types ──────────────────────────────────────────────────────────────

/**
 * Thrown by any ConversationRetrievalService method when the call occurs
 * outside of a request context (userId not set in AsyncLocalStorage).
 * Guards prevent cross-user data leakage.
 */
export class MissingRequestContextError extends Error {
	constructor(method: string) {
		super(
			`ConversationRetrievalService.${method}() called outside a requestContext — userId is required`,
		);
		this.name = 'MissingRequestContextError';
	}
}

/**
 * Thrown when a ConversationRetrievalService method is called without the
 * required requestContext (e.g. userId absent for a user-scoped data source).
 */
export class ConversationRetrievalError extends Error {
	readonly category: AllowedSourceCategory;
	constructor(message: string, category: AllowedSourceCategory) {
		super(message);
		this.name = 'ConversationRetrievalError';
		this.category = category;
	}
}

// ─── Public interface + supporting types ─────────────────────────────────────

export interface ContextSnapshotOptions {
	question: string;
	mode: 'free-text' | 'ask';
	dataQueryCandidate: boolean;
	/**
	 * Whether the PAS classifier emitted YES_SETTINGS — signals that the user is
	 * asking about configuring their personal settings. When true, `chooseSources`
	 * includes the 'settings' source in free-text mode (always included in ask mode).
	 * Defaults to false when absent.
	 */
	settingsCandidate?: boolean;
	recentFilePaths: string[];
	include?: { [K in AllowedSourceCategory]?: boolean };
	characterBudget?: number;
}

/**
 * Character budget defaults (approximate prompt-injection limits).
 * Total budget across all categories; each category slice is capped
 * proportionally by DEFAULT_CATEGORY_BUDGET_CHARS.
 */
const DEFAULT_TOTAL_BUDGET_CHARS = 24_000;
const DEFAULT_CATEGORY_BUDGET_CHARS = 6_000;

export interface ConversationContextSnapshot {
	/** Context store entries for the current user. */
	contextStore?: ContextEntry[];
	/** Apps enabled for the current user. */
	enabledApps?: AppInfo[];
	/** App knowledge search results. */
	appKnowledge?: KnowledgeEntry[];
	/** Formatted system data block (admin-gated by category). */
	systemDataBlock?: string;
	/** Data query result (user-accessible files). */
	dataQueryResult?: DataQueryResult;
	/** Reports scoped to the current user. */
	reports?: ReportDefinition[];
	/** Alerts scoped to the current user. */
	alerts?: AlertDefinition[];
	/**
	 * Sanitized settings catalog string — rendered inside a `<memory-context>` fence
	 * in the system prompt. Contains nlSafe key descriptions from SettingsReader.
	 */
	settingsCatalog?: string;
	/**
	 * Trusted instruction block — rendered as plain text in the system prompt,
	 * outside any `<memory-context>` fence. Contains safe LLM instructions from
	 * SettingsReader (e.g., "To change X, say 'set X to Y'").
	 */
	settingsTrustedInstructions?: string;
	/** Categories that failed to load (partial-failure tolerance). */
	failures: AllowedSourceCategory[];
}

/**
 * Options for searching conversation transcripts via FTS5.
 * Note: `userId` is intentionally absent — it is always derived from
 * requestContext. Callers cannot supply or override the userId.
 */
export interface SessionSearchOpts {
	queryTerms: string[];
	limitSessions?: number;
	limitMessagesPerSession?: number;
	startedAfter?: string;
	startedBefore?: string;
	/** Filter on message timestamp (m.timestamp >= messageAfter). ISO8601 UTC inclusive. */
	messageAfter?: string;
	/** Filter on message timestamp (m.timestamp < messageBefore). ISO8601 UTC exclusive. */
	messageBefore?: string;
	excludeSessionIds?: string[];
}

export interface ConversationRetrievalService {
	/** Query user-accessible data files using natural language. */
	searchData(args: { question: string; recentFilePaths?: string[] }): Promise<DataQueryResult>;
	/** List all context store entries for the current user. */
	listContextEntries(): Promise<ContextEntry[]>;
	/** Get recent interaction entries for the current user. */
	getRecentInteractions(): Promise<InteractionEntry[]>;
	/** Get apps enabled for the current user. */
	getEnabledApps(): Promise<AppInfo[]>;
	/** Search app documentation/knowledge base. */
	searchAppKnowledge(query: string): Promise<KnowledgeEntry[]>;
	/** Build system data block (admin status derived from requestContext, not caller-provided). */
	buildSystemDataBlock(args: { question: string }): Promise<string>;
	/** List reports scoped to the current user (Chunk B scoped API). */
	listScopedReports(): Promise<ReportDefinition[]>;
	/** List alerts scoped to the current user (Chunk B scoped API). */
	listScopedAlerts(): Promise<AlertDefinition[]>;
	/**
	 * Returns true when a FTS5 ChatTranscriptIndex is wired.
	 * Callers use this to gate the recall LLM classifier — no index means no
	 * recall search is possible, so the classifier call is skipped entirely.
	 */
	hasSessionSearch(): boolean;
	/**
	 * Search conversation transcripts via FTS5.
	 * userId is always derived from requestContext — callers cannot supply it.
	 * Throws ConversationRetrievalError if no userId is in context.
	 * Returns { hits: [] } if no index is injected.
	 */
	searchSessions(opts: SessionSearchOpts): Promise<SearchResult>;
	/**
	 * Build the settings catalog and trusted instruction block.
	 * Returns `{ catalog, trustedInstructions }` — or empty strings when no settings
	 * service is wired. Requires a userId in the current requestContext.
	 */
	buildSettingsCatalog(): Promise<{ catalog: string; trustedInstructions: string }>;
	/** Compose a full context snapshot for LLM injection. */
	buildContextSnapshot(opts: ContextSnapshotOptions): Promise<ConversationContextSnapshot>;
	/**
	 * Build a frozen MemorySnapshot from durable ContextStore entries.
	 * Called at session-mint time, before the first prompt is assembled.
	 * Requires a userId in the current requestContext.
	 *
	 * @param opts.pinnedKeys - Keys to guarantee inclusion at the front of the snapshot.
	 * @param opts.kinds - Override the entry-kind filter. Defaults to DURABLE_KINDS when
	 *   strict_durable_kinds is true, otherwise CONTEXT_ENTRY_KINDS (all 6 kinds).
	 */
	buildMemorySnapshot(opts?: {
		pinnedKeys?: string[];
		kinds?: ContextEntryKind[];
	}): Promise<MemorySnapshot>;
}

// ─── Structural service interfaces ───────────────────────────────────────────
// Use structural interfaces (not class imports) to keep coupling loose.

export interface ReportServiceForRetrieval {
	listForUser(userId: string): Promise<ReportDefinition[]>;
}

export interface AlertServiceForRetrieval {
	listForUser(userId: string): Promise<AlertDefinition[]>;
}

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface ConversationRetrievalDeps {
	dataQuery?: DataQueryService;
	contextStore?: ContextStoreService;
	interactionContext?: InteractionContextService;
	appMetadata?: AppMetadataService;
	appKnowledge?: AppKnowledgeBaseService;
	systemInfo?: SystemInfoService;
	reportService?: ReportServiceForRetrieval;
	alertService?: AlertServiceForRetrieval;
	/** Optional FTS5 transcript index (Hermes P5). Absent → searchSessions returns { hits: [] }. */
	index?: ChatTranscriptIndex;
	logger?: AppLogger;
	/**
	 * Operator system config — when provided, `buildMemorySnapshot` reads
	 * `chat.memory.strict_durable_kinds` to decide whether to exclude
	 * untyped ContextStore entries from the durable memory snapshot.
	 */
	systemConfig?: SystemConfig;
	/**
	 * Optional SettingsReader — when provided, `buildSettingsCatalog` returns
	 * real per-user catalog + trusted instruction block from the registry.
	 * Absent → buildSettingsCatalog returns empty strings (degraded, not an error).
	 */
	settingsReader?: SettingsReader;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class ConversationRetrievalServiceImpl implements ConversationRetrievalService {
	private readonly deps: ConversationRetrievalDeps;
	private readonly systemInfoReader?: ConversationSystemInfoReader;

	constructor(deps: ConversationRetrievalDeps) {
		this.deps = deps;
		if (deps.systemInfo) {
			this.systemInfoReader = new ConversationSystemInfoReader(deps.systemInfo, deps.logger);
		}
	}

	/**
	 * Assert that we are running inside a requestContext with a userId set.
	 * Called at the top of every method that touches user data.
	 */
	private assertRequestContext(method: string): string {
		const userId = getCurrentUserId();
		if (!userId) {
			throw new MissingRequestContextError(method);
		}
		return userId;
	}

	async searchData(args: {
		question: string;
		recentFilePaths?: string[];
	}): Promise<DataQueryResult> {
		const userId = this.assertRequestContext('searchData');
		if (!this.deps.dataQuery) {
			throw new Error('ConversationRetrievalService.searchData: DataQueryService not wired');
		}
		// Require householdId: DataQueryService falls back to all-shared files when absent,
		// which can leak data across households. Fail closed to prevent the fallback.
		if (getCurrentHouseholdId() === undefined) {
			throw new Error(
				'ConversationRetrievalService.searchData: householdId required in requestContext',
			);
		}
		const opts = args.recentFilePaths?.length
			? { recentFilePaths: args.recentFilePaths }
			: undefined;
		return this.deps.dataQuery.query(args.question, userId, opts);
	}

	async listContextEntries(): Promise<ContextEntry[]> {
		const userId = this.assertRequestContext('listContextEntries');
		if (!this.deps.contextStore) {
			throw new Error(
				'ConversationRetrievalService.listContextEntries: ContextStoreService not wired',
			);
		}
		return this.deps.contextStore.listForUser(userId);
	}

	async getRecentInteractions(): Promise<InteractionEntry[]> {
		const userId = this.assertRequestContext('getRecentInteractions');
		if (!this.deps.interactionContext) {
			throw new Error(
				'ConversationRetrievalService.getRecentInteractions: InteractionContextService not wired',
			);
		}
		return this.deps.interactionContext.getRecent(userId);
	}

	async getEnabledApps(): Promise<AppInfo[]> {
		const userId = this.assertRequestContext('getEnabledApps');
		if (!this.deps.appMetadata) {
			throw new Error('ConversationRetrievalService.getEnabledApps: AppMetadataService not wired');
		}
		return this.deps.appMetadata.getEnabledApps(userId);
	}

	async searchAppKnowledge(query: string): Promise<KnowledgeEntry[]> {
		const userId = this.assertRequestContext('searchAppKnowledge');
		if (!this.deps.appKnowledge) {
			throw new Error(
				'ConversationRetrievalService.searchAppKnowledge: AppKnowledgeBaseService not wired',
			);
		}
		return this.deps.appKnowledge.search(query, userId);
	}

	async buildSystemDataBlock(args: { question: string }): Promise<string> {
		this.assertRequestContext('buildSystemDataBlock');
		if (!this.systemInfoReader) {
			throw new Error(
				'ConversationRetrievalService.buildSystemDataBlock: SystemInfoService not wired',
			);
		}
		return this.systemInfoReader.buildSystemDataBlock(args);
	}

	async listScopedReports(): Promise<ReportDefinition[]> {
		const userId = this.assertRequestContext('listScopedReports');
		if (!this.deps.reportService) {
			throw new Error('ConversationRetrievalService.listScopedReports: ReportService not wired');
		}
		return this.deps.reportService.listForUser(userId);
	}

	async listScopedAlerts(): Promise<AlertDefinition[]> {
		const userId = this.assertRequestContext('listScopedAlerts');
		if (!this.deps.alertService) {
			throw new Error('ConversationRetrievalService.listScopedAlerts: AlertService not wired');
		}
		return this.deps.alertService.listForUser(userId);
	}

	hasSessionSearch(): boolean {
		return this.deps.index !== undefined;
	}

	async searchSessions(opts: SessionSearchOpts): Promise<SearchResult> {
		// Throws ConversationRetrievalError (not MissingRequestContextError) so the failure carries
		// the source-policy category 'conversation-transcripts' — prevents future refactors from
		// silently unifying the error type.
		const userId = getCurrentUserId();
		const householdId = getCurrentHouseholdId() ?? null;
		if (userId === undefined) {
			throw new ConversationRetrievalError(
				'searchSessions requires an authenticated user in requestContext',
				'conversation-transcripts',
			);
		}
		if (!this.deps.index) {
			return { hits: [] };
		}
		return this.deps.index.searchSessions({
			userId,
			householdId,
			queryTerms: opts.queryTerms,
			limitSessions: opts.limitSessions,
			limitMessagesPerSession: opts.limitMessagesPerSession,
			startedAfter: opts.startedAfter,
			startedBefore: opts.startedBefore,
			messageAfter: opts.messageAfter,
			messageBefore: opts.messageBefore,
			excludeSessionIds: opts.excludeSessionIds,
		});
	}

	async buildSettingsCatalog(): Promise<{ catalog: string; trustedInstructions: string }> {
		if (!this.deps.settingsReader) {
			return { catalog: '', trustedInstructions: '' };
		}
		const userId = this.assertRequestContext('buildSettingsCatalog');
		const isAdmin = this.deps.systemInfo?.isUserAdmin(userId) ?? false;
		// Let errors propagate — buildContextSnapshot uses Promise.allSettled so a throw
		// here becomes a rejected promise that pushes 'settings' to snapshot.failures.
		// Direct callers (outside buildContextSnapshot) still catch via their own try/catch.
		return this.deps.settingsReader.buildCatalog({ userId, isAdmin });
	}

	async buildMemorySnapshot(
		opts: { pinnedKeys?: string[]; kinds?: ContextEntryKind[] } = {},
	): Promise<MemorySnapshot> {
		const userId = this.assertRequestContext('buildMemorySnapshot');
		const BUDGET = 4_000;
		const MARKER = '... (snapshot truncated at session start)';
		const builtAt = new Date().toISOString();
		const pinned = opts.pinnedKeys ?? ['recent-session-summary'];

		const strictDurable = this.deps.systemConfig?.chat?.memory?.strict_durable_kinds === true;
		const defaultKinds = strictDurable ? DURABLE_KINDS : CONTEXT_ENTRY_KINDS;
		const kinds = opts.kinds ?? defaultKinds;

		let entries: ContextEntry[];
		try {
			// biome-ignore lint/style/noNonNullAssertion: contextStore is required for buildMemorySnapshot (callers wire it)
			entries = await this.deps.contextStore!.listDurableForUser(userId, {
				kinds: [...kinds],
				bypass: CONTEXT_INTERNAL_BYPASS,
			});
		} catch (err) {
			this.deps.logger?.warn(
				'buildMemorySnapshot: ContextStore read failed — returning degraded snapshot: %s',
				err,
			);
			return { content: '', status: 'degraded', builtAt, entryCount: 0 };
		}

		if (entries.length === 0) {
			return { content: '', status: 'empty', builtAt, entryCount: 0 };
		}

		// Pinned entries first (in pinnedKeys order), then alphabetical remainder.
		const pinnedSet = new Set(pinned);
		const pinnedEntries = pinned
			.map((k) => entries.find((e) => e.key === k))
			.filter((e): e is ContextEntry => e !== undefined);
		const remaining = entries
			.filter((e) => !pinnedSet.has(e.key))
			.sort((a, b) => a.key.localeCompare(b.key));
		const ordered = [...pinnedEntries, ...remaining];

		const BUDGET_BODY = BUDGET - MARKER.length;

		let content = '';
		let includedCount = 0;
		let truncated = false;
		for (const entry of ordered) {
			const rendered = `## ${entry.key}\n${entry.content}\n\n`;
			if (content.length + rendered.length > BUDGET_BODY) {
				if (content.length === 0) {
					// First entry alone exceeds budget — include a partial to avoid a marker-only result.
					content = rendered.slice(0, BUDGET_BODY);
					includedCount = 1;
				}
				truncated = true;
				break;
			}
			content += rendered;
			includedCount++;
		}
		if (truncated) {
			content += MARKER;
		}

		return { content: content.trimEnd(), status: 'ok', builtAt, entryCount: includedCount };
	}

	async buildContextSnapshot(opts: ContextSnapshotOptions): Promise<ConversationContextSnapshot> {
		const userId = this.assertRequestContext('buildContextSnapshot');
		const snapshot: ConversationContextSnapshot = { failures: [] };

		const selected = chooseSources(opts);
		const totalBudget = opts.characterBudget ?? DEFAULT_TOTAL_BUDGET_CHARS;

		// Fan out to all selected readers in parallel — partial fill on failure
		const tasks: Array<{
			category: AllowedSourceCategory;
			promise: Promise<unknown>;
		}> = [];

		if (selected.has('context-store') && this.deps.contextStore) {
			tasks.push({
				category: 'context-store',
				promise: this.deps.contextStore.listForUser(userId),
			});
		} else if (selected.has('context-store')) {
			snapshot.failures.push('context-store');
		}

		if (selected.has('app-metadata') && this.deps.appMetadata) {
			tasks.push({
				category: 'app-metadata',
				promise: this.deps.appMetadata.getEnabledApps(userId),
			});
		} else if (selected.has('app-metadata')) {
			snapshot.failures.push('app-metadata');
		}

		if (selected.has('app-knowledge') && this.deps.appKnowledge) {
			tasks.push({
				category: 'app-knowledge',
				promise: this.deps.appKnowledge.search(opts.question, userId),
			});
		} else if (selected.has('app-knowledge')) {
			snapshot.failures.push('app-knowledge');
		}

		if (selected.has('system-info') && this.systemInfoReader) {
			tasks.push({
				category: 'system-info',
				// Admin status derived inside the reader from systemInfo.isUserAdmin(userId)
				promise: this.systemInfoReader.buildSystemDataBlock({ question: opts.question }),
			});
		} else if (selected.has('system-info')) {
			snapshot.failures.push('system-info');
		}

		// Data query covers all four DataQuery scope categories.
		// Require householdId: DataQueryService returns all shared files when absent,
		// which can leak data across households. Fail closed when missing.
		const dataQueryCategories: AllowedSourceCategory[] = [
			'user-app-data',
			'household-shared-data',
			'space-data',
			'collaboration-data',
		];
		const anyDataQuerySelected = dataQueryCategories.some((c) => selected.has(c));
		if (anyDataQuerySelected) {
			const householdId = getCurrentHouseholdId();
			if (householdId === undefined) {
				for (const cat of dataQueryCategories) {
					if (selected.has(cat)) snapshot.failures.push(cat);
				}
			} else if (this.deps.dataQuery) {
				const recentFilePaths = opts.recentFilePaths.length ? opts.recentFilePaths : undefined;
				tasks.push({
					category: 'user-app-data', // representative key covering all four DataQuery scope categories
					promise: this.deps.dataQuery.query(
						opts.question,
						userId,
						recentFilePaths ? { recentFilePaths } : undefined,
					),
				});
			} else {
				for (const cat of dataQueryCategories) {
					if (selected.has(cat)) snapshot.failures.push(cat);
				}
			}
		}

		if (selected.has('reports') && this.deps.reportService) {
			tasks.push({
				category: 'reports',
				promise: this.deps.reportService.listForUser(userId),
			});
		} else if (selected.has('reports')) {
			snapshot.failures.push('reports');
		}

		if (selected.has('alerts') && this.deps.alertService) {
			tasks.push({
				category: 'alerts',
				promise: this.deps.alertService.listForUser(userId),
			});
		} else if (selected.has('alerts')) {
			snapshot.failures.push('alerts');
		}

		// Settings catalog — reader absent → push 'settings' to failures (consistent with other sources).
		// When reader is present, wrap in a rejecting promise so allSettled catches throws.
		if (selected.has('settings')) {
			if (!this.deps.settingsReader) {
				snapshot.failures.push('settings');
			} else {
				tasks.push({
					category: 'settings',
					promise: this.buildSettingsCatalog(),
				});
			}
		}

		// Await all tasks with partial-failure tolerance
		const settled = await Promise.allSettled(tasks.map((t) => t.promise));

		let charsUsed = 0;

		for (const [i, task] of tasks.entries()) {
			const result = settled[i];
			if (!result) continue;

			if (result.status === 'rejected') {
				if (selected.has(task.category)) snapshot.failures.push(task.category);
				if (task.category === 'user-app-data') {
					// Also mark the other DataQuery scope categories as failed
					for (const cat of [
						'household-shared-data',
						'space-data',
						'collaboration-data',
					] as AllowedSourceCategory[]) {
						if (selected.has(cat)) snapshot.failures.push(cat);
					}
				}
				this.deps.logger?.warn(
					`ConversationRetrievalService: reader failed for category=${task.category}`,
					result.reason,
				);
				continue;
			}

			const value = result.value;

			// Enforce character budget (simple per-category cap)
			const catBudget = Math.min(DEFAULT_CATEGORY_BUDGET_CHARS, totalBudget - charsUsed);
			if (catBudget <= 0) {
				// Budget exhausted — mark remaining fulfilled tasks as failed.
				// DataQuery tasks represent 4 categories under one task key; mark all.
				if (selected.has(task.category)) snapshot.failures.push(task.category);
				if (task.category === 'user-app-data') {
					for (const cat of [
						'household-shared-data',
						'space-data',
						'collaboration-data',
					] as AllowedSourceCategory[]) {
						if (selected.has(cat)) snapshot.failures.push(cat);
					}
				}
				this.deps.logger?.warn(
					`ConversationRetrievalService: budget exhausted, dropping fulfilled category=${task.category}`,
				);
				continue;
			}

			switch (task.category) {
				case 'context-store': {
					const entries = value as ContextEntry[];
					const truncated = truncateArray(
						entries,
						catBudget,
						(e) => e.content.length + e.key.length,
					);
					snapshot.contextStore = truncated;
					charsUsed += truncated.reduce((sum, e) => sum + e.content.length + e.key.length, 0);
					break;
				}
				case 'app-metadata': {
					const apps = value as AppInfo[];
					// Pre-compute sizes once to avoid double-stringify in truncateArray + sum
					const sizeMap = new Map<AppInfo, number>(apps.map((a) => [a, JSON.stringify(a).length]));
					const truncated = truncateArray(apps, catBudget, (a) => sizeMap.get(a) ?? 0);
					snapshot.enabledApps = truncated;
					charsUsed += truncated.reduce((sum, a) => sum + (sizeMap.get(a) ?? 0), 0);
					break;
				}
				case 'app-knowledge': {
					const entries = value as KnowledgeEntry[];
					const truncated = truncateArray(entries, catBudget, (e) => e.content.length);
					snapshot.appKnowledge = truncated;
					charsUsed += truncated.reduce((sum, e) => sum + e.content.length, 0);
					break;
				}
				case 'system-info': {
					const block = value as string;
					snapshot.systemDataBlock = block.length > catBudget ? block.slice(0, catBudget) : block;
					charsUsed += snapshot.systemDataBlock.length;
					break;
				}
				case 'user-app-data': {
					// This task key represents all four DataQuery scope categories.
					// Truncate by rendered (formatted) size so the 6 KB catBudget actually holds.
					// formatDataQueryContext renders `[header]\n${content}` per file joined with `\n\n`.
					const result = value as DataQueryResult;
					let remaining = catBudget;
					const truncatedFiles: DataQueryResult['files'] = [];
					let fileIndex = 0;
					for (const file of result.files) {
						const headerOverhead =
							`[${[file.appId, file.type, file.title].filter(Boolean).join(' / ')}]\n`.length;
						const separatorOverhead = fileIndex > 0 ? 2 : 0;
						const overhead = headerOverhead + separatorOverhead;
						if (remaining <= overhead) break;
						const contentBudget = remaining - overhead;
						const content = file.content.slice(0, contentBudget);
						remaining -= overhead + content.length;
						truncatedFiles.push({ ...file, content });
						fileIndex++;
					}
					snapshot.dataQueryResult = { files: truncatedFiles, empty: truncatedFiles.length === 0 };
					charsUsed += formatDataQueryContext(snapshot.dataQueryResult).length;
					break;
				}
				case 'reports': {
					const reports = value as ReportDefinition[];
					const accepted: ReportDefinition[] = [];
					for (const r of reports) {
						if (formatReportLines([...accepted, r]).length > catBudget) break;
						accepted.push(r);
					}
					snapshot.reports = accepted;
					charsUsed += formatReportLines(accepted).length;
					break;
				}
				case 'alerts': {
					const alerts = value as AlertDefinition[];
					const accepted: AlertDefinition[] = [];
					for (const a of alerts) {
						if (formatAlertLines([...accepted, a]).length > catBudget) break;
						accepted.push(a);
					}
					snapshot.alerts = accepted;
					charsUsed += formatAlertLines(accepted).length;
					break;
				}
				case 'settings': {
					const { catalog, trustedInstructions } = value as {
						catalog: string;
						trustedInstructions: string;
					};
					if (catalog) {
						snapshot.settingsCatalog = catalog;
						charsUsed += catalog.length;
					}
					if (trustedInstructions) {
						snapshot.settingsTrustedInstructions = trustedInstructions;
						// trustedInstructions does not count toward the memory budget —
						// it is rendered outside any <memory-context> fence.
					}
					break;
				}
				default:
					// Unknown category — skip
					break;
			}
		}

		return snapshot;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncate an array of items to fit within a character budget.
 * Items are included from the front until the budget is exhausted.
 */
function truncateArray<T>(items: T[], budget: number, sizeOf: (item: T) => number): T[] {
	let used = 0;
	const result: T[] = [];
	for (const item of items) {
		const size = sizeOf(item);
		if (used + size > budget) break;
		result.push(item);
		used += size;
	}
	return result;
}
