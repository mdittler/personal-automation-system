/**
 * Graceful shutdown manager.
 *
 * Tracks in-flight requests, waits for them to complete on shutdown,
 * and orchestrates service teardown in the correct order.
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { RateLimiter } from './rate-limiter.js';

/** Services that the shutdown manager needs to tear down. */
export interface ShutdownServices {
	scheduler: { stop(): void | Promise<void> };
	telegram: { cleanup(): void };
	registry: { shutdownAll(): Promise<void> };
	eventBus: { clearAll(): void };
	server: FastifyInstance;
	rateLimiters: RateLimiter[];
	/** grammY bot instance — only set in polling mode, needs stop() on shutdown. */
	bot?: { stop(): void };
	/** Additional dispose callbacks (e.g. LLMGuard rate limiters, cost tracker flush). */
	onShutdown?: Array<() => void | Promise<void>>;
}

export interface ShutdownManagerOptions {
	logger: Logger;
	/** Maximum time (ms) to wait for in-flight requests before forcing shutdown. */
	drainTimeoutMs?: number;
}

export class ShutdownManager {
	private readonly logger: Logger;
	private readonly drainTimeoutMs: number;
	private services: ShutdownServices | null = null;
	private inFlightCount = 0;
	private shuttingDown = false;

	constructor(options: ShutdownManagerOptions) {
		this.logger = options.logger;
		this.drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
	}

	/** Register the services to tear down on shutdown. */
	registerServices(services: ShutdownServices): void {
		this.services = services;
	}

	/** Whether the system is in the process of shutting down. */
	isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	/**
	 * Wrap an async operation to track it as in-flight.
	 * If shutdown is in progress, the operation is skipped silently.
	 */
	async trackRequest<T>(fn: () => Promise<T>): Promise<T | undefined> {
		if (this.shuttingDown) return undefined;

		this.inFlightCount++;
		try {
			return await fn();
		} finally {
			this.inFlightCount--;
		}
	}

	/**
	 * Initiate graceful shutdown.
	 *
	 * 1. Stop accepting new requests
	 * 2. Wait for in-flight requests to drain (with timeout)
	 * 3. Tear down services in order
	 * 4. Exit process
	 */
	async shutdown(signal: string): Promise<void> {
		if (this.shuttingDown) return; // Prevent double-shutdown
		this.shuttingDown = true;

		this.logger.info({ signal }, 'Shutting down...');

		// Wait for in-flight requests to drain
		await this.waitForDrain();

		if (this.services) {
			const { scheduler, telegram, registry, eventBus, server, rateLimiters, bot, onShutdown } =
				this.services;

			// Stop polling first (if running in polling mode)
			if (bot) {
				bot.stop();
			}

			await scheduler.stop();
			telegram.cleanup();
			await registry.shutdownAll();
			eventBus.clearAll();

			for (const limiter of rateLimiters) {
				limiter.dispose();
			}

			// Run additional shutdown callbacks (LLMGuard disposal, cost tracker flush, etc.)
			if (onShutdown) {
				for (const callback of onShutdown) {
					try {
						await callback();
					} catch {
						// Best-effort cleanup — don't block shutdown
					}
				}
			}

			await server.close();
		}

		this.logger.info('Shutdown complete');
		process.exit(0);
	}

	/**
	 * Register SIGTERM and SIGINT handlers.
	 * Call this once after services are registered.
	 */
	register(): void {
		const handler = (signal: string) => void this.shutdown(signal);
		process.on('SIGTERM', () => handler('SIGTERM'));
		process.on('SIGINT', () => handler('SIGINT'));
	}

	/** Wait for in-flight count to reach 0, with a timeout. */
	private waitForDrain(): Promise<void> {
		if (this.inFlightCount === 0) return Promise.resolve();

		this.logger.info(
			{ inFlight: this.inFlightCount },
			'Waiting for in-flight requests to complete...',
		);

		return new Promise<void>((resolve) => {
			const start = Date.now();

			const check = () => {
				if (this.inFlightCount === 0) {
					resolve();
					return;
				}

				if (Date.now() - start >= this.drainTimeoutMs) {
					this.logger.warn(
						{ remaining: this.inFlightCount },
						'Drain timeout exceeded, forcing shutdown',
					);
					resolve();
					return;
				}

				setTimeout(check, 100);
			};

			check();
		});
	}
}
