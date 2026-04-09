/**
 * App module and core services contract.
 *
 * This is the most critical type file. It defines:
 * - AppModule: what every app must export from its index.ts
 * - CoreServices: what apps receive in their init() function
 * - AppLogger: scoped logger for apps
 *
 * Apps only receive the services they declared in requirements.services.
 */

import type { AppKnowledgeBaseService } from './app-knowledge.js';
import type { AppMetadataService } from './app-metadata.js';
import type { AudioService } from './audio.js';
import type { ConditionEvaluatorService } from './condition.js';
import type { AppConfigService } from './config.js';
import type { ContextStoreService } from './context-store.js';
import type { DataStoreService } from './data-store.js';
import type { EventBusService } from './events.js';
import type { LLMService } from './llm.js';
import type { ModelJournalService } from './model-journal.js';
import type { SchedulerService } from './scheduler.js';
import type { SystemInfoService } from './system-info.js';
import type { CallbackContext, MessageContext, PhotoContext, TelegramService } from './telegram.js';

/** Infrastructure-mediated access to declared external API secrets. */
export interface SecretsService {
	/** Get a secret value by its declared external_apis ID. Returns undefined if not set. */
	get(id: string): string | undefined;
	/** Check if a secret is available. */
	has(id: string): boolean;
}

/** What every app exports from its index.ts. */
export interface AppModule {
	/**
	 * Called once when the infrastructure loads the app.
	 * Store the services reference — this is the app's API to everything.
	 */
	init(services: CoreServices): Promise<void>;

	/**
	 * Called when the router sends a text message to the app.
	 * This is the main handler.
	 */
	handleMessage(ctx: MessageContext): Promise<void>;

	/**
	 * Called when the router sends a photo message to the app.
	 * Only called if the manifest declares accepts_photos: true.
	 */
	handlePhoto?(ctx: PhotoContext): Promise<void>;

	/**
	 * Called when a user sends an explicit /command routed to the app.
	 * Only called for commands declared in the manifest.
	 */
	handleCommand?(command: string, args: string[], ctx: MessageContext): Promise<void>;

	/**
	 * Called when a user taps an inline keyboard button routed to this app.
	 * Only called for buttons with callback data prefixed `app:<appId>:`.
	 * The `data` parameter is the app-specific portion after prefix stripping.
	 */
	handleCallbackQuery?(data: string, ctx: CallbackContext): Promise<void>;

	/**
	 * Called when a manifest-declared cron schedule fires.
	 *
	 * - `jobId` matches the schedule's `id` field in the manifest.
	 * - `userId` is passed when the schedule declares `user_scope: all`.
	 *   The infrastructure invokes the handler once per registered system
	 *   user (within a `requestContext.run({ userId }, ...)` scope, so
	 *   `services.config.get` returns that user's overrides automatically).
	 *   For `user_scope: shared` and `user_scope: system` jobs, `userId`
	 *   is undefined and the handler runs once.
	 */
	handleScheduledJob?(jobId: string, userId?: string): Promise<void>;

	/**
	 * Called when the system shuts down.
	 * Close connections, flush caches, etc.
	 */
	shutdown?(): Promise<void>;
}

/**
 * Infrastructure services provided to apps.
 *
 * Apps receive this object in their init() function.
 * They only get the services they declared in manifest requirements.services.
 * Accessing an undeclared service will be undefined.
 */
export interface CoreServices {
	/** Send and receive Telegram messages. */
	telegram: TelegramService;
	/** Local (Ollama) and remote (Claude) LLM access. */
	llm: LLMService;
	/** File-based data storage with per-user and shared scoping. */
	data: DataStoreService;
	/** Dynamic one-off job scheduling. Cron jobs are from manifests. */
	scheduler: SchedulerService;
	/** Programmatic condition checking against rule files. */
	conditionEvaluator: ConditionEvaluatorService;
	/** Text-to-speech and speaker casting. */
	audio: AudioService;
	/** In-process event pub/sub for inter-app communication. */
	eventBus: EventBusService;
	/** Read-only shared knowledge base of user preferences and facts. */
	contextStore: ContextStoreService;
	/** Per-user app configuration from the management GUI. */
	config: AppConfigService;
	/** Read-only metadata about installed apps. */
	appMetadata: AppMetadataService;
	/** Read-only knowledge base of app and infrastructure documentation. */
	appKnowledge: AppKnowledgeBaseService;
	/** Persistent file the AI model can write to freely during interactions. */
	modelJournal: ModelJournalService;
	/** Read-only system introspection (models, costs, scheduling, status) + model switching. */
	systemInfo: SystemInfoService;
	/** Infrastructure-mediated access to declared external API secrets. */
	secrets: SecretsService;
	/** IANA timezone string from system config (e.g. 'America/New_York'). */
	timezone: string;
	/** Scoped structured logger. */
	logger: AppLogger;
}

/** Scoped logger interface for apps. Backed by Pino. */
export interface AppLogger {
	trace(msg: string, ...args: unknown[]): void;
	debug(msg: string, ...args: unknown[]): void;
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
	fatal(msg: string, ...args: unknown[]): void;
	/** Create a child logger with additional context. */
	child(bindings: Record<string, unknown>): AppLogger;
}
