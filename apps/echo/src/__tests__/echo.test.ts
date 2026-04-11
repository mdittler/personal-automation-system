import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockCoreServices,
	createMockScopedStore,
} from '../../../../core/src/testing/mock-services.js';
import { createTestMessageContext } from '../../../../core/src/testing/test-helpers.js';
import * as echo from '../index.js';

describe('Echo App', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	describe('init', () => {
		it('should store services without error', async () => {
			await expect(echo.init(services)).resolves.toBeUndefined();
		});
	});

	describe('handleMessage', () => {
		beforeEach(async () => {
			await echo.init(services);
		});

		it('should echo the text back to the user', async () => {
			const ctx = createTestMessageContext({ text: 'hello world' });

			await echo.handleMessage(ctx);

			expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'hello world');
		});

		it('escapes Markdown control characters in echoed text', async () => {
			const ctx = createTestMessageContext({ text: 'hello *world* and _test_' });

			await echo.handleMessage(ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				'hello \\*world\\* and \\_test\\_',
			);
		});

		it('should append the message to log.md', async () => {
			const store = createMockScopedStore();
			vi.mocked(services.data.forUser).mockReturnValue(store);

			const ctx = createTestMessageContext({ text: 'test message' });

			await echo.handleMessage(ctx);

			expect(services.data.forUser).toHaveBeenCalledWith('test-user');
			expect(store.append).toHaveBeenCalledWith(
				'log.md',
				expect.stringContaining('test message'),
				expect.objectContaining({ frontmatter: expect.stringContaining('---') }),
			);
		});
	});

	describe('handleCommand', () => {
		beforeEach(async () => {
			await echo.init(services);
		});

		it('should echo joined args back to the user', async () => {
			const ctx = createTestMessageContext();

			// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on echo module
			await echo.handleCommand!('/echo', ['hello', 'world'], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'hello world');
		});

		it('escapes Markdown control characters in command args', async () => {
			// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on echo module
			await echo.handleCommand!('/echo', ['*bold*', '_italic_'], createTestMessageContext());

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				'\\*bold\\* \\_italic\\_',
			);
		});

		it('should send "(empty)" when no args given', async () => {
			const ctx = createTestMessageContext();

			// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on echo module
			await echo.handleCommand!('/echo', [], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith('test-user', '(empty)');
		});

		it('should append the command to log.md', async () => {
			const store = createMockScopedStore();
			vi.mocked(services.data.forUser).mockReturnValue(store);

			const ctx = createTestMessageContext();

			// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on echo module
			await echo.handleCommand!('/echo', ['hi'], ctx);

			expect(store.append).toHaveBeenCalledWith(
				'log.md',
				expect.stringContaining('/echo hi'),
				expect.objectContaining({ frontmatter: expect.stringContaining('---') }),
			);
		});
	});
});
