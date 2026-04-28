/**
 * ConversationRetrievalService Source Policy.
 *
 * Code-locks the full set of data sources the conversation engine may access
 * (ALLOWED_SOURCES) and the categories it must never touch (DENIED_SOURCES).
 * Every method on ConversationRetrievalService maps to one or more allowed
 * categories via METHOD_SOURCE_CATEGORIES — new data sources require an
 * explicit policy entry here before they can be wired in.
 *
 * Auth model vocabulary:
 *  - user-scoped          — only the calling user's own data
 *  - household-membership — any member of the same household
 *  - space-membership     — explicit SpaceService.isMember check
 *  - collaboration-membership — cross-household, SpaceService.isMember
 *  - admin-gated          — admin users only (isAdmin check per category)
 */

// ─── Allowed source categories ────────────────────────────────────────────────

export type AllowedSourceCategory =
	| 'user-app-data' //           DataQueryService — scope: 'user'
	| 'household-shared-data' //   DataQueryService — scope: 'shared' (household-membership)
	| 'space-data' //              DataQueryService — scope: 'space' (space-membership)
	| 'collaboration-data' //      DataQueryService — scope: 'collaboration' (cross-household, SpaceService.isMember)
	| 'context-store' //           ContextStore.listForUser
	| 'interaction-context' //     InteractionContextService.getRecent
	| 'app-metadata' //            AppMetadataService.getEnabledApps / getInstalledApps
	| 'app-knowledge' //           AppKnowledgeBase.search
	| 'system-info' //             ConversationSystemInfoReader (admin-gated by category, preserves gatherSystemData semantics)
	| 'reports' //                 ReportService.listForUser   (NEW scoped API in Chunk B)
	| 'alerts' //                  AlertService.listForUser    (NEW scoped API in Chunk B)
	| 'conversation-transcripts'; // ChatTranscriptIndex.searchSessions (Hermes P5)

// ─── Denied source categories ─────────────────────────────────────────────────

export type DeniedSourceCategory =
	| 'credentials'
	| 'api-keys'
	| 'secrets'
	| 'other-user-personal-data'
	| 'other-household-data'
	| 'admin-only-config'
	| 'cost-tracker-raw-rows'
	| 'internal-logs'
	| 'model-journal-entries';

// ─── Sets ─────────────────────────────────────────────────────────────────────

export const ALLOWED_SOURCES: ReadonlySet<AllowedSourceCategory> = new Set([
	'user-app-data',
	'household-shared-data',
	'space-data',
	'collaboration-data',
	'context-store',
	'interaction-context',
	'app-metadata',
	'app-knowledge',
	'system-info',
	'reports',
	'alerts',
	'conversation-transcripts',
] as const);

export const DENIED_SOURCES: ReadonlySet<DeniedSourceCategory> = new Set([
	'credentials',
	'api-keys',
	'secrets',
	'other-user-personal-data',
	'other-household-data',
	'admin-only-config',
	'cost-tracker-raw-rows',
	'internal-logs',
	'model-journal-entries',
] as const);

// ─── SOURCE_POLICY map ────────────────────────────────────────────────────────

export interface SourcePolicyEntry {
	category: AllowedSourceCategory;
	underlyingService: string;
	underlyingMethod: string;
	authModel:
		| 'user-scoped'
		| 'household-membership'
		| 'space-membership'
		| 'collaboration-membership'
		| 'admin-gated';
	notes?: string;
}

export const SOURCE_POLICY: ReadonlyMap<AllowedSourceCategory, SourcePolicyEntry> = new Map([
	[
		'user-app-data',
		{
			category: 'user-app-data',
			underlyingService: 'DataQueryService',
			underlyingMethod: 'query',
			authModel: 'user-scoped',
		},
	],
	[
		'household-shared-data',
		{
			category: 'household-shared-data',
			underlyingService: 'DataQueryService',
			underlyingMethod: 'query',
			authModel: 'household-membership',
		},
	],
	[
		'space-data',
		{
			category: 'space-data',
			underlyingService: 'DataQueryService',
			underlyingMethod: 'query',
			authModel: 'space-membership',
		},
	],
	[
		'collaboration-data',
		{
			category: 'collaboration-data',
			underlyingService: 'DataQueryService',
			underlyingMethod: 'query',
			authModel: 'collaboration-membership',
		},
	],
	[
		'context-store',
		{
			category: 'context-store',
			underlyingService: 'ContextStoreService',
			underlyingMethod: 'listForUser',
			authModel: 'user-scoped',
		},
	],
	[
		'interaction-context',
		{
			category: 'interaction-context',
			underlyingService: 'InteractionContextService',
			underlyingMethod: 'getRecent',
			authModel: 'user-scoped',
		},
	],
	[
		'app-metadata',
		{
			category: 'app-metadata',
			underlyingService: 'AppMetadataService',
			underlyingMethod: 'getEnabledApps',
			authModel: 'user-scoped',
		},
	],
	[
		'app-knowledge',
		{
			category: 'app-knowledge',
			underlyingService: 'AppKnowledgeBaseService',
			underlyingMethod: 'search',
			authModel: 'user-scoped',
		},
	],
	[
		'system-info',
		{
			category: 'system-info',
			underlyingService: 'ConversationSystemInfoReader',
			underlyingMethod: 'buildSystemDataBlock',
			authModel: 'admin-gated',
		},
	],
	[
		'reports',
		{
			category: 'reports',
			underlyingService: 'ReportService',
			underlyingMethod: 'listForUser',
			authModel: 'user-scoped',
			notes: 'scoped API added in Chunk B',
		},
	],
	[
		'alerts',
		{
			category: 'alerts',
			underlyingService: 'AlertService',
			underlyingMethod: 'listForUser',
			authModel: 'user-scoped',
			notes: 'scoped API added in Chunk B',
		},
	],
	[
		'conversation-transcripts',
		{
			category: 'conversation-transcripts',
			underlyingService: 'ChatTranscriptIndex',
			underlyingMethod: 'searchSessions',
			authModel: 'user-scoped',
			notes: 'userId derived from requestContext; no caller-supplied identity accepted',
		},
	],
]);

// ─── Method → Category mapping ────────────────────────────────────────────────

/**
 * N:M mapping from ConversationRetrievalService method name to the source
 * categories it reads. searchData covers 4 DataQuery scopes.
 *
 * This table is the authoritative record of what data each method touches.
 * Adding a new method or data source requires updating this table and
 * SOURCE_POLICY before the method can be wired in Chunk C/D.
 */
export const METHOD_SOURCE_CATEGORIES = {
	searchData: ['user-app-data', 'household-shared-data', 'space-data', 'collaboration-data'],
	listContextEntries: ['context-store'],
	getRecentInteractions: ['interaction-context'],
	getEnabledApps: ['app-metadata'],
	searchAppKnowledge: ['app-knowledge'],
	buildSystemDataBlock: ['system-info'],
	listScopedReports: ['reports'],
	listScopedAlerts: ['alerts'],
	searchSessions: ['conversation-transcripts'],
	// buildContextSnapshot orchestrates the above methods rather than reading any category directly
	// so it has no SOURCE_POLICY mapping entry
} as const satisfies Record<string, readonly AllowedSourceCategory[]>;
