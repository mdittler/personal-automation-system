/**
 * PAS type system — barrel export.
 *
 * All types are re-exported from here. Apps import from '@core/types'
 * or from '@pas/core/types'.
 */

// Core contract
export type { AppModule, CoreServices, AppLogger } from './app-module.js';

// Manifest
export type {
	AppManifest,
	ManifestIdentity,
	ManifestCapabilities,
	ManifestMessages,
	ManifestCommand,
	ManifestSchedule,
	ManifestRules,
	ManifestEvents,
	ManifestEventEmit,
	ManifestEventSubscribe,
	ManifestRequirements,
	ManifestExternalApi,
	ManifestDataRequirements,
	ManifestDataScope,
	ManifestIntegration,
	ManifestUserConfig,
} from './manifest.js';

// Telegram
export type { CallbackContext, InlineButton, MessageContext, PhotoContext, SentMessage, TelegramService } from './telegram.js';

// LLM
export type {
	LLMProvider,
	LLMCompletionOptions,
	ClassifyResult,
	LLMService,
	ProviderType,
	ModelTier,
	ModelRef,
	LLMCompletionResult,
	LLMClient,
	LLMProviderClient,
	ProviderModel,
} from './llm.js';

// Data Store
export type {
	ScopedDataStore,
	UserDataStore,
	SharedDataStore,
	DataStoreService,
	ChangeLogEntry,
} from './data-store.js';

// Scheduler
export type {
	ScheduledJob,
	OneOffTask,
	JobExecutionResult,
	SchedulerService,
} from './scheduler.js';

// Condition Evaluator
export type {
	Rule,
	RuleStatus,
	RuleEvaluationResult,
	ConditionEvaluatorService,
} from './condition.js';

// Events
export type { EventHandler, EventBusService } from './events.js';

// Audio
export type { AudioService } from './audio.js';

// Context Store
export type { ContextEntry, ContextStoreService } from './context-store.js';

// App Metadata
export type { AppInfo, CommandInfo, AppMetadataService } from './app-metadata.js';

// App Knowledge
export type { KnowledgeEntry, AppKnowledgeBaseService } from './app-knowledge.js';

// Model Journal
export type { ModelJournalService } from './model-journal.js';

// System Info
export type {
	SystemInfoService,
	TierInfo,
	ProviderInfo,
	CostSummary,
	ModelPricingInfo,
	ScheduledJobInfo,
	SystemStatusInfo,
	SafeguardInfo,
	AvailableModelInfo,
} from './system-info.js';

// Config
export type {
	SystemConfig,
	AppConfigService,
	LLMProviderConfig,
	TierAssignment,
	LLMSafeguardsConfig,
	LLMConfig,
} from './config.js';

// Users
export type { RegisteredUser } from './users.js';
