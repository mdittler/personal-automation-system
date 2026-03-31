import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it } from 'vitest';
import * as app from '../index.js';

describe('{{APP_NAME}}', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	describe('init', () => {
		it('should store services without error', async () => {
			await expect(app.init(services)).resolves.toBeUndefined();
		});
	});

	describe('handleMessage', () => {
		beforeEach(async () => {
			await app.init(services);
		});

		it('should respond to the user', async () => {
			const ctx = createTestMessageContext({ text: 'hello' });
			await app.handleMessage(ctx);
			expect(services.telegram.send).toHaveBeenCalledWith('test-user', expect.any(String));
		});

		it('should append to log with frontmatter', async () => {
			const ctx = createTestMessageContext({ text: 'hello' });
			await app.handleMessage(ctx);
			const store = services.data.forUser('test-user');
			expect(store.append).toHaveBeenCalledWith(
				'log.md',
				expect.stringContaining('hello'),
				expect.objectContaining({ frontmatter: expect.stringContaining('---') }),
			);
		});
	});

	describe('handleCommand', () => {
		beforeEach(async () => {
			await app.init(services);
		});

		it('should handle the command', async () => {
			const ctx = createTestMessageContext();
			// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on app module
			await app.handleCommand!('/{{APP_COMMAND}}', ['test'], ctx);
			expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'test');
		});

		it('should append to log with frontmatter', async () => {
			const ctx = createTestMessageContext();
			// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on app module
			await app.handleCommand!('/{{APP_COMMAND}}', ['test'], ctx);
			const store = services.data.forUser('test-user');
			expect(store.append).toHaveBeenCalledWith(
				'log.md',
				expect.stringContaining('test'),
				expect.objectContaining({ frontmatter: expect.stringContaining('---') }),
			);
		});
	});
});
