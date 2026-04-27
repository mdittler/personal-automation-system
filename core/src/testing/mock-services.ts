/**
 * Reusable mock CoreServices factory for app unit tests.
 *
 * Creates a complete CoreServices object with all methods stubbed as
 * vitest mock functions. Supports targeted overrides for specific test
 * scenarios. Import from '@pas/core' or '@core/testing/mock-services'.
 */

import { vi } from 'vitest';
import type { AppKnowledgeBaseService } from '../types/app-knowledge.js';
import type { AppMetadataService } from '../types/app-metadata.js';
import type { AppLogger, CoreServices } from '../types/app-module.js';
import type { DataQueryService } from '../types/data-query.js';
import type { InteractionContextService } from '../services/interaction-context/index.js';
import type { AudioService } from '../types/audio.js';
import type { ConditionEvaluatorService } from '../types/condition.js';
import type { AppConfigService } from '../types/config.js';
import type { ContextStoreService } from '../types/context-store.js';
import type { DataStoreService, ScopedDataStore } from '../types/data-store.js';
import type { EventBusService } from '../types/events.js';
import type { LLMService } from '../types/llm.js';
import type { ModelJournalService } from '../types/model-journal.js';
import type { SchedulerService } from '../types/scheduler.js';
import type { SystemInfoService } from '../types/system-info.js';
import type { TelegramService } from '../types/telegram.js';

/** Create a mock ScopedDataStore with all methods stubbed. */
export function createMockScopedStore(
	overrides?: Partial<Record<keyof ScopedDataStore, unknown>>,
): ScopedDataStore {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as ScopedDataStore;
}

/** Create a mock AppLogger. */
function createMockLogger(): AppLogger {
	const logger: AppLogger = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(),
	};
	// child() returns the same logger mock for chaining
	vi.mocked(logger.child).mockReturnValue(logger);
	return logger;
}

/** Deep partial type for overriding specific service methods. */
type MockOverrides = {
	[K in keyof CoreServices]?: K extends 'dataQuery'
		? Partial<DataQueryService>
		: K extends 'interactionContext'
		? Partial<InteractionContextService>
		: Partial<Record<string, unknown>>;
};

/**
 * Create a complete mock CoreServices object.
 *
 * All methods are stubbed with sensible defaults (resolving promises,
 * empty returns). Pass overrides to customize specific methods:
 *
 * ```ts
 * const services = createMockCoreServices({
 *   telegram: { send: vi.fn().mockRejectedValue(new Error('fail')) },
 * });
 * ```
 */
export function createMockCoreServices(overrides?: MockOverrides): CoreServices {
	const scopedStore = createMockScopedStore(
		overrides?.data as Partial<Record<keyof ScopedDataStore, unknown>>,
	);

	const telegram: TelegramService = {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
		sendWithButtons: vi.fn().mockResolvedValue({ chatId: 123, messageId: 456 }),
		editMessage: vi.fn().mockResolvedValue(undefined),
		...overrides?.telegram,
	};

	const data: DataStoreService = {
		forUser: vi.fn().mockReturnValue(scopedStore),
		forShared: vi.fn().mockReturnValue(scopedStore),
		forSpace: vi.fn().mockReturnValue(scopedStore),
		...overrides?.data,
	};

	const llm: LLMService = {
		complete: vi.fn().mockResolvedValue(''),
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0 }),
		extractStructured: vi.fn().mockResolvedValue({}),
		getModelForTier: vi.fn().mockReturnValue('anthropic/mock-model'),
		...overrides?.llm,
	};

	const scheduler: SchedulerService = {
		scheduleOnce: vi.fn().mockResolvedValue(undefined),
		cancelOnce: vi.fn().mockResolvedValue(undefined),
		...overrides?.scheduler,
	};

	const conditionEvaluator: ConditionEvaluatorService = {
		evaluate: vi.fn().mockResolvedValue(false),
		getRuleStatus: vi.fn().mockResolvedValue({
			id: '',
			lastFired: null,
			cooldownRemaining: 0,
			isActive: true,
		}),
		...overrides?.conditionEvaluator,
	};

	const audio: AudioService = {
		speak: vi.fn().mockResolvedValue(undefined),
		tts: vi.fn().mockResolvedValue(Buffer.alloc(0)),
		...overrides?.audio,
	};

	const eventBus: EventBusService = {
		emit: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		...overrides?.eventBus,
	};

	const contextStore: ContextStoreService = {
		get: vi.fn().mockResolvedValue(null),
		search: vi.fn().mockResolvedValue([]),
		searchForUser: vi.fn().mockResolvedValue([]),
		getForUser: vi.fn().mockResolvedValue(null),
		listForUser: vi.fn().mockResolvedValue([]),
		save: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
		...overrides?.contextStore,
	};

	const config: AppConfigService = {
		get: vi.fn().mockResolvedValue(undefined),
		getAll: vi.fn().mockResolvedValue({}),
		getOverrides: vi.fn().mockResolvedValue(null),
		setAll: vi.fn().mockResolvedValue(undefined),
		updateOverrides: vi.fn().mockResolvedValue(undefined),
		...overrides?.config,
	};

	const appMetadata: AppMetadataService = {
		getInstalledApps: vi.fn().mockReturnValue([]),
		getEnabledApps: vi.fn().mockResolvedValue([]),
		getAppInfo: vi.fn().mockReturnValue(null),
		getCommandList: vi.fn().mockReturnValue([]),
		...overrides?.appMetadata,
	};

	const appKnowledge: AppKnowledgeBaseService = {
		search: vi.fn().mockResolvedValue([]),
		...overrides?.appKnowledge,
	};

	const modelJournal: ModelJournalService = {
		read: vi.fn().mockResolvedValue(''),
		append: vi.fn().mockResolvedValue(undefined),
		listArchives: vi.fn().mockResolvedValue([]),
		readArchive: vi.fn().mockResolvedValue(''),
		listModels: vi.fn().mockResolvedValue([]),
		...overrides?.modelJournal,
	};

	const logger = createMockLogger();

	return {
		telegram,
		llm,
		data,
		scheduler,
		conditionEvaluator,
		audio,
		eventBus,
		contextStore,
		config,
		appMetadata,
		appKnowledge,
		modelJournal,
		systemInfo: {
			getTierAssignments: vi.fn().mockReturnValue([]),
			getProviders: vi.fn().mockReturnValue([]),
			getAvailableModels: vi.fn().mockResolvedValue([]),
			getModelPricing: vi.fn().mockReturnValue(null),
			getCostSummary: vi
				.fn()
				.mockReturnValue({ month: '2026-03', monthlyTotal: 0, perApp: {}, perUser: {} }),
			getScheduledJobs: vi.fn().mockReturnValue([]),
			getSystemStatus: vi.fn().mockReturnValue({
				uptimeSeconds: 0,
				appCount: 0,
				userCount: 0,
				cronJobCount: 0,
				timezone: 'UTC',
			}),
			getSafeguardDefaults: vi.fn().mockReturnValue({
				rateLimit: { maxRequests: 60, windowSeconds: 3600 },
				appMonthlyCostCap: 10,
				globalMonthlyCostCap: 50,
			}),
			setTierModel: vi.fn().mockResolvedValue({ success: true }),
			isUserAdmin: vi.fn().mockReturnValue(false),
			...overrides?.systemInfo,
		} as SystemInfoService,
		secrets: {
			get: vi.fn().mockReturnValue(undefined),
			has: vi.fn().mockReturnValue(false),
			...overrides?.secrets,
		},
		dataQuery: overrides?.dataQuery
			? ({ query: vi.fn().mockResolvedValue({ files: [], empty: true }), ...overrides.dataQuery } as DataQueryService)
			: undefined,
		interactionContext: overrides?.interactionContext
			? ({ record: vi.fn(), getRecent: vi.fn().mockReturnValue([]), ...overrides.interactionContext } as InteractionContextService)
			: undefined,
		timezone: 'UTC',
		logger,
	};
}
