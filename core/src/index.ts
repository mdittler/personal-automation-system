/**
 * @pas/core — Personal Automation System Infrastructure
 *
 * This is the barrel export for the core package. Types and service
 * implementations are re-exported from here as they are built.
 */

// All types
export type {
	// Core contract
	AppModule,
	CoreServices,
	AppLogger,
	// Manifest
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
	// Telegram
	MessageContext,
	PhotoContext,
	TelegramService,
	// LLM
	LLMProvider,
	LLMCompletionOptions,
	ClassifyResult,
	LLMService,
	// Data Store
	ScopedDataStore,
	UserDataStore,
	SharedDataStore,
	DataStoreService,
	ChangeLogEntry,
	// Scheduler
	ScheduledJob,
	OneOffTask,
	JobExecutionResult,
	SchedulerService,
	// Condition Evaluator
	Rule,
	RuleStatus,
	RuleEvaluationResult,
	ConditionEvaluatorService,
	// Events
	EventHandler,
	EventBusService,
	// Audio
	AudioService,
	// Context Store
	ContextEntry,
	ContextStoreService,
	// Config
	SystemConfig,
	AppConfigService,
	// Users
	RegisteredUser,
} from './types/index.js';

// Bootstrap entry point
export { main } from './bootstrap.js';

// Service implementations (used by bootstrap and testing)
export { AppRegistry, ManifestCache } from './services/app-registry/index.js';
export type { RegisteredApp, ServiceFactory } from './services/app-registry/index.js';
export { Router } from './services/router/index.js';
export { TelegramServiceImpl } from './services/telegram/index.js';
export { createBot, createWebhookCallback } from './services/telegram/bot.js';
export { createServer, registerHealthRoute, registerWebhookRoute } from './server/index.js';

// Phase 7 service implementations
export { ContextStoreServiceImpl } from './services/context-store/index.js';
export { AudioServiceImpl } from './services/audio/index.js';
export { DailyDiffService, collectChanges, summarizeChanges } from './services/daily-diff/index.js';
export type { DailyChanges } from './services/daily-diff/index.js';

// Testing utilities (used by app tests)
export { createMockCoreServices, createMockScopedStore } from './testing/mock-services.js';
export { createTestMessageContext, createTestPhotoContext } from './testing/test-helpers.js';
