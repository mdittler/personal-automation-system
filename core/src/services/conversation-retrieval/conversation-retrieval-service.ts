/**
 * ConversationRetrievalService skeleton.
 *
 * Chunk A: service is fully wired via DI but all methods throw 'not implemented'
 * until Chunk C composes the real readers. The requestContext guard on every
 * method ensures the service is only called within a properly-scoped request
 * (userId must be set in AsyncLocalStorage before any real data access).
 *
 * Chunk C fills in all method bodies.
 * Chunk D wires the service into handleMessage / handleAsk.
 */

import type { AppKnowledgeBaseService } from '../../types/app-knowledge.js';
import type { AppMetadataService } from '../../types/app-metadata.js';
import type { AppLogger } from '../../types/app-module.js';
import type { ContextStoreService } from '../../types/context-store.js';
import type { DataQueryResult } from '../../types/data-query.js';
import type { DataQueryService } from '../../types/data-query.js';
import type { SystemInfoService } from '../../types/system-info.js';
import { getCurrentUserId } from '../context/request-context.js';
import type { InteractionContextService } from '../interaction-context/index.js';
import type { AllowedSourceCategory } from './source-policy.js';

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

// ─── Public interface + supporting types ─────────────────────────────────────

export interface ContextSnapshotOptions {
	question: string;
	mode: 'free-text' | 'ask';
	dataQueryCandidate: boolean;
	recentFilePaths: string[];
	isAdmin: boolean;
	include?: { [K in AllowedSourceCategory]?: boolean };
	characterBudget?: number;
}

export interface ConversationContextSnapshot {
	/** Categories that failed to load (partial-failure tolerance). */
	failures: AllowedSourceCategory[];
	// Additional fields added in Chunk C (data, appInfo, contextEntries, …).
}

export interface ConversationRetrievalService {
	/** Query user-accessible data files using natural language. */
	searchData(args: { question: string; recentFilePaths?: string[] }): Promise<DataQueryResult>;
	/** List all context store entries for the current user. */
	listContextEntries(): Promise<unknown[]>; // full types added in Chunk C
	/** Get recent interaction entries for the current user. */
	getRecentInteractions(): Promise<unknown[]>; // full types added in Chunk C
	/** Get apps enabled for the current user. */
	getEnabledApps(): Promise<unknown[]>; // full types added in Chunk C
	/** Search app documentation/knowledge base. */
	searchAppKnowledge(query: string): Promise<unknown[]>; // full types added in Chunk C
	/** Build system data block (admin-gated). */
	buildSystemDataBlock(args: { question: string; isAdmin: boolean }): Promise<string>;
	/** List reports scoped to the current user (Chunk B scoped API). */
	listScopedReports(): Promise<unknown[]>; // full types added in Chunk C
	/** List alerts scoped to the current user (Chunk B scoped API). */
	listScopedAlerts(): Promise<unknown[]>; // full types added in Chunk C
	/** Compose a full context snapshot for LLM injection. */
	buildContextSnapshot(opts: ContextSnapshotOptions): Promise<ConversationContextSnapshot>;
}

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface ConversationRetrievalDeps {
	dataQuery?: DataQueryService;
	contextStore?: ContextStoreService;
	interactionContext?: InteractionContextService;
	appMetadata?: AppMetadataService;
	appKnowledge?: AppKnowledgeBaseService;
	systemInfo?: SystemInfoService;
	logger?: AppLogger;
	// ReportService / AlertService deps added in Chunk B
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class ConversationRetrievalServiceImpl implements ConversationRetrievalService {
	private readonly deps: ConversationRetrievalDeps;

	constructor(deps: ConversationRetrievalDeps) {
		this.deps = deps;
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

	async searchData(_args: {
		question: string;
		recentFilePaths?: string[];
	}): Promise<DataQueryResult> {
		this.assertRequestContext('searchData');
		throw new Error('not implemented yet — blocked on Chunk B/C');
	}

	async listContextEntries(): Promise<unknown[]> {
		this.assertRequestContext('listContextEntries');
		throw new Error('not implemented yet — blocked on Chunk B/C');
	}

	async getRecentInteractions(): Promise<unknown[]> {
		this.assertRequestContext('getRecentInteractions');
		throw new Error('not implemented yet — blocked on Chunk B/C');
	}

	async getEnabledApps(): Promise<unknown[]> {
		this.assertRequestContext('getEnabledApps');
		throw new Error('not implemented yet — blocked on Chunk B/C');
	}

	async searchAppKnowledge(_query: string): Promise<unknown[]> {
		this.assertRequestContext('searchAppKnowledge');
		throw new Error('not implemented yet — blocked on Chunk B/C');
	}

	async buildSystemDataBlock(_args: { question: string; isAdmin: boolean }): Promise<string> {
		this.assertRequestContext('buildSystemDataBlock');
		throw new Error('not implemented yet — blocked on Chunk B/C');
	}

	async listScopedReports(): Promise<unknown[]> {
		this.assertRequestContext('listScopedReports');
		throw new Error('not implemented yet — blocked on Chunk B scoped APIs');
	}

	async listScopedAlerts(): Promise<unknown[]> {
		this.assertRequestContext('listScopedAlerts');
		throw new Error('not implemented yet — blocked on Chunk B scoped APIs');
	}

	async buildContextSnapshot(_opts: ContextSnapshotOptions): Promise<ConversationContextSnapshot> {
		this.assertRequestContext('buildContextSnapshot');
		throw new Error('not implemented yet — blocked on Chunk B/C');
	}
}
