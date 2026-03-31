import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalErrorHandlers } from '../error-handler.js';

function createMockLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

describe('registerGlobalErrorHandlers', () => {
	let processOnSpy: ReturnType<typeof vi.spyOn>;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let capturedHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		capturedHandlers = new Map();
		processOnSpy = vi
			.spyOn(process, 'on')
			.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
				capturedHandlers.set(event, handler);
				return process;
			});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		processOnSpy.mockRestore();
		exitSpy.mockRestore();
		vi.restoreAllMocks();
	});

	it('registers an uncaughtException handler', () => {
		const logger = createMockLogger();
		registerGlobalErrorHandlers(logger);
		expect(capturedHandlers.has('uncaughtException')).toBe(true);
	});

	it('registers an unhandledRejection handler', () => {
		const logger = createMockLogger();
		registerGlobalErrorHandlers(logger);
		expect(capturedHandlers.has('unhandledRejection')).toBe(true);
	});

	it('logs fatal on uncaughtException', () => {
		const logger = createMockLogger();
		registerGlobalErrorHandlers(logger);

		const error = new Error('boom');
		const handler = capturedHandlers.get('uncaughtException') as (...args: unknown[]) => void;
		handler(error);

		expect(logger.fatal).toHaveBeenCalledWith(
			{ error, type: 'uncaughtException' },
			expect.stringContaining('Uncaught exception'),
		);
	});

	it('calls shutdownFn on uncaughtException when provided', () => {
		const logger = createMockLogger();
		const shutdownFn = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(globalThis, 'setTimeout').mockReturnValue({
			unref: vi.fn(),
		} as unknown as NodeJS.Timeout);

		registerGlobalErrorHandlers(logger, shutdownFn);

		const handler = capturedHandlers.get('uncaughtException') as (...args: unknown[]) => void;
		handler(new Error('boom'));

		expect(shutdownFn).toHaveBeenCalledWith('uncaughtException');
	});

	it('exits immediately when no shutdownFn is provided', () => {
		const logger = createMockLogger();
		registerGlobalErrorHandlers(logger);

		const handler = capturedHandlers.get('uncaughtException') as (...args: unknown[]) => void;
		handler(new Error('boom'));

		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('sets 30s force-exit timeout on uncaughtException with shutdownFn', () => {
		const logger = createMockLogger();
		const shutdownFn = vi.fn().mockResolvedValue(undefined);
		const unrefMock = vi.fn();
		const setTimeoutSpy = vi
			.spyOn(globalThis, 'setTimeout')
			.mockReturnValue({ unref: unrefMock } as unknown as NodeJS.Timeout);

		registerGlobalErrorHandlers(logger, shutdownFn);

		const handler = capturedHandlers.get('uncaughtException') as (...args: unknown[]) => void;
		handler(new Error('boom'));

		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
		expect(unrefMock).toHaveBeenCalled();
	});

	it('does not call process.exit when shutdownFn is provided', () => {
		const logger = createMockLogger();
		const shutdownFn = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(globalThis, 'setTimeout').mockReturnValue({
			unref: vi.fn(),
		} as unknown as NodeJS.Timeout);

		registerGlobalErrorHandlers(logger, shutdownFn);

		const handler = capturedHandlers.get('uncaughtException') as (...args: unknown[]) => void;
		handler(new Error('boom'));

		// process.exit is not called directly — only via the timeout callback
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('logs error on unhandledRejection', () => {
		const logger = createMockLogger();
		registerGlobalErrorHandlers(logger);

		const reason = new Error('rejected');
		const handler = capturedHandlers.get('unhandledRejection') as (...args: unknown[]) => void;
		handler(reason);

		expect(logger.error).toHaveBeenCalledWith(
			{ error: reason, type: 'unhandledRejection' },
			expect.stringContaining('Unhandled promise rejection'),
		);
	});

	it('does not exit on unhandledRejection', () => {
		const logger = createMockLogger();
		registerGlobalErrorHandlers(logger);

		const handler = capturedHandlers.get('unhandledRejection') as (...args: unknown[]) => void;
		handler(new Error('rejected'));

		expect(exitSpy).not.toHaveBeenCalled();
	});
});
