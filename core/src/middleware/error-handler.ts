/**
 * Global error handlers.
 *
 * Registers process-level handlers for uncaught exceptions and
 * unhandled rejections. Ensures the system logs errors and
 * attempts graceful shutdown on fatal errors.
 */

import type { Logger } from 'pino';

/**
 * Register global error handlers.
 *
 * @param logger - Logger instance for error reporting
 * @param shutdownFn - Called on uncaughtException to trigger graceful shutdown
 */
export function registerGlobalErrorHandlers(
	logger: Logger,
	shutdownFn?: (signal: string) => Promise<void>,
): void {
	process.on('uncaughtException', (error) => {
		logger.fatal({ error, type: 'uncaughtException' }, 'Uncaught exception — shutting down');

		if (shutdownFn) {
			void shutdownFn('uncaughtException');
			// Force exit if graceful shutdown hangs
			setTimeout(() => process.exit(1), 30_000).unref();
		} else {
			process.exit(1);
		}
	});

	process.on('unhandledRejection', (reason) => {
		logger.error({ error: reason, type: 'unhandledRejection' }, 'Unhandled promise rejection');
		// Do NOT exit — most rejections are from app-level code
		// that is already error-isolated by the router.
	});
}
