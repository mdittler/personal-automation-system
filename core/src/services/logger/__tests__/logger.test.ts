import { describe, expect, it } from 'vitest';
import { createChildLogger, createLogger } from '../index.js';

describe('createLogger', () => {
	it('creates a logger instance with default options', async () => {
		const logger = await createLogger({ pretty: true, level: 'silent' });
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe('function');
		expect(typeof logger.error).toBe('function');
		expect(typeof logger.debug).toBe('function');
		expect(typeof logger.warn).toBe('function');
	});

	it('respects the log level option', async () => {
		const logger = await createLogger({ pretty: true, level: 'error' });
		expect(logger.level).toBe('error');
	});

	it('creates child loggers with context', async () => {
		const parent = await createLogger({ pretty: true, level: 'silent' });
		const child = createChildLogger(parent, { service: 'router' });

		expect(child).toBeDefined();
		expect(typeof child.info).toBe('function');
	});

	it('creates child loggers with app context', async () => {
		const parent = await createLogger({ pretty: true, level: 'silent' });
		const child = createChildLogger(parent, { appId: 'grocery' });

		expect(child).toBeDefined();
		expect(typeof child.info).toBe('function');
	});

	it('defaults to info level when no level specified', async () => {
		const logger = await createLogger({ pretty: true });
		expect(logger.level).toBe('info');
	});

	it('creates child logger with empty context object', async () => {
		const parent = await createLogger({ pretty: true, level: 'silent' });
		const child = createChildLogger(parent, {});

		expect(child).toBeDefined();
		expect(typeof child.info).toBe('function');
	});

	it('creates child logger with both service and appId context', async () => {
		const parent = await createLogger({ pretty: true, level: 'silent' });
		const child = createChildLogger(parent, { service: 'router', appId: 'echo' });

		expect(child).toBeDefined();
		expect(typeof child.info).toBe('function');
	});
});
