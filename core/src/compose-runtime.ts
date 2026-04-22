/**
 * composeRuntime() — typed skeleton.
 *
 * Exports the public types for the runtime composition API.
 * The real implementation lives in Task 4; this stub throws at runtime
 * so the smoke test can fail with a clear "not yet implemented" message
 * rather than a TypeScript error.
 */

import type { Logger } from 'pino';
import type { Telegraf } from 'telegraf';
import type { FastifyInstance } from 'fastify';
import type { SystemConfig } from './types/config.js';
import type { TelegramService } from './types/telegram.js';
import type { ProviderRegistry } from './services/llm/providers/provider-registry.js';
import type { ShutdownManager } from './middleware/shutdown.js';

export interface RuntimeOverrides {
	dataDir?: string;
	configPath?: string;
	config?: SystemConfig;
	providerRegistry?: ProviderRegistry;
	telegramService?: TelegramService & { cleanup(): void | Promise<void> };
	logger?: Logger;
}

/**
 * Named bundle of all runtime services.
 * Task 4 will narrow this to concrete service types.
 */
export interface RuntimeServices {
	[key: string]: unknown;
}

export interface RuntimeHandle {
	services: RuntimeServices;
	bot: Telegraf;
	server: FastifyInstance;
	shutdownManager: ShutdownManager;
	dispose: () => Promise<void>;
}

/**
 * Compose all PAS runtime services from scratch (or from overrides for testing).
 *
 * Returns a fully-wired RuntimeHandle without starting Telegraf polling,
 * the Fastify HTTP listener, or the scheduler.
 *
 * NOTE: Not yet implemented — Task 4 provides the real body.
 */
export async function composeRuntime(_overrides?: RuntimeOverrides): Promise<RuntimeHandle> {
	throw new Error('composeRuntime: not yet implemented');
}
