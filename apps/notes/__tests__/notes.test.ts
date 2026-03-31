import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockCoreServices,
	createMockScopedStore,
} from '../../../core/src/testing/mock-services.js';
import { createTestMessageContext } from '../../../core/src/testing/test-helpers.js';
import * as notes from '../src/index.js';

describe('Notes App', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	describe('init', () => {
		it('should store services without error', async () => {
			await expect(notes.init(services)).resolves.toBeUndefined();
		});
	});

	describe('handleMessage', () => {
		beforeEach(async () => {
			await notes.init(services);
		});

		it('should save note to daily file', async () => {
			const store = createMockScopedStore();
			vi.mocked(services.data.forUser).mockReturnValue(store);

			const ctx = createTestMessageContext({ text: 'Buy groceries' });
			await notes.handleMessage(ctx);

			expect(services.data.forUser).toHaveBeenCalledWith('test-user');
			expect(store.append).toHaveBeenCalledWith(
				expect.stringMatching(/^daily-notes\/\d{4}-\d{2}-\d{2}\.md$/),
				expect.stringContaining('Buy groceries'),
				expect.objectContaining({ frontmatter: expect.stringContaining('---') }),
			);
			expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'Noted.');
		});

		it('should handle empty message text gracefully', async () => {
			const ctx = createTestMessageContext({ text: '' });
			await notes.handleMessage(ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				'Empty note — nothing to save.',
			);
		});

		it('should handle whitespace-only message', async () => {
			const ctx = createTestMessageContext({ text: '   ' });
			await notes.handleMessage(ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				'Empty note — nothing to save.',
			);
		});
	});

	describe('timezone', () => {
		it('should use configured timezone for note timestamps', async () => {
			services.timezone = 'America/New_York';
			await notes.init(services);

			const store = createMockScopedStore();
			vi.mocked(services.data.forUser).mockReturnValue(store);

			const ctx = createTestMessageContext({ text: 'Test note' });
			await notes.handleMessage(ctx);

			// Note should be saved with a time formatted in the configured timezone
			expect(store.append).toHaveBeenCalledWith(
				expect.stringMatching(/^daily-notes\/\d{4}-\d{2}-\d{2}\.md$/),
				expect.stringMatching(/^- \[\d{2}:\d{2}\] Test note\n$/),
				expect.objectContaining({ frontmatter: expect.stringContaining('---') }),
			);
		});
	});

	describe('handleCommand', () => {
		beforeEach(async () => {
			await notes.init(services);
		});

		describe('/note', () => {
			it('should save note via command', async () => {
				const store = createMockScopedStore();
				vi.mocked(services.data.forUser).mockReturnValue(store);

				const ctx = createTestMessageContext();
				// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on notes module
				await notes.handleCommand!('/note', ['Meeting', 'at', '3pm'], ctx);

				expect(store.append).toHaveBeenCalledWith(
					expect.stringMatching(/^daily-notes\/\d{4}-\d{2}-\d{2}\.md$/),
					expect.stringContaining('Meeting at 3pm'),
					expect.objectContaining({ frontmatter: expect.stringContaining('---') }),
				);
				expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'Noted.');
			});

			it('should show usage when /note has no text', async () => {
				const ctx = createTestMessageContext();
				// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on notes module
				await notes.handleCommand!('/note', [], ctx);

				expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'Usage: /note <text>');
			});
		});

		describe('/notes', () => {
			it('should list recent notes', async () => {
				const store = createMockScopedStore({
					read: vi.fn().mockResolvedValue('- [10:00] First note\n- [11:00] Second note\n'),
				});
				vi.mocked(services.data.forUser).mockReturnValue(store);

				const ctx = createTestMessageContext();
				// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on notes module
				await notes.handleCommand!('/notes', [], ctx);

				const sentMessage = vi.mocked(services.telegram.send).mock.calls[0][1] as string;
				expect(sentMessage).toContain('First note');
				expect(sentMessage).toContain('Second note');
				expect(sentMessage).toContain("Today's notes (2/2)");
			});

			it('should send empty message when no notes', async () => {
				const store = createMockScopedStore({
					read: vi.fn().mockResolvedValue(''),
				});
				vi.mocked(services.data.forUser).mockReturnValue(store);

				const ctx = createTestMessageContext();
				// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on notes module
				await notes.handleCommand!('/notes', [], ctx);

				expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'No notes today.');
			});

			it('should respect notes_per_page config', async () => {
				const lines = Array.from(
					{ length: 15 },
					(_, i) => `- [${String(i).padStart(2, '0')}:00] Note ${i + 1}`,
				);
				const store = createMockScopedStore({
					read: vi.fn().mockResolvedValue(`${lines.join('\n')}\n`),
				});
				vi.mocked(services.data.forUser).mockReturnValue(store);
				vi.mocked(services.config.get).mockResolvedValue(5);

				const ctx = createTestMessageContext();
				// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on notes module
				await notes.handleCommand!('/notes', [], ctx);

				const sentMessage = vi.mocked(services.telegram.send).mock.calls[0][1] as string;
				expect(sentMessage).toContain('5/15');
				expect(sentMessage).toContain('Note 15');
				expect(sentMessage).not.toContain('Note 1\n');
			});
		});

		describe('/summarize', () => {
			it('should call LLM and send summary', async () => {
				const store = createMockScopedStore({
					read: vi.fn().mockResolvedValue('- [10:00] Met with team\n- [14:00] Fixed bug\n'),
				});
				vi.mocked(services.data.forUser).mockReturnValue(store);
				vi.mocked(services.llm.complete).mockResolvedValue(
					'You had a productive day with a meeting and bug fix.',
				);

				const ctx = createTestMessageContext();
				// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on notes module
				await notes.handleCommand!('/summarize', [], ctx);

				expect(services.llm.complete).toHaveBeenCalledWith(
					expect.stringContaining('Summarize'),
					expect.objectContaining({ tier: 'fast' }),
				);
				expect(services.telegram.send).toHaveBeenCalledWith(
					'test-user',
					expect.stringContaining('productive day'),
				);
			});

			it('should handle no notes gracefully', async () => {
				const store = createMockScopedStore({
					read: vi.fn().mockResolvedValue(''),
				});
				vi.mocked(services.data.forUser).mockReturnValue(store);

				const ctx = createTestMessageContext();
				// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on notes module
				await notes.handleCommand!('/summarize', [], ctx);

				expect(services.llm.complete).not.toHaveBeenCalled();
				expect(services.telegram.send).toHaveBeenCalledWith(
					'test-user',
					'No notes to summarize today.',
				);
			});

			it('should handle LLM failure gracefully', async () => {
				const store = createMockScopedStore({
					read: vi.fn().mockResolvedValue('- [10:00] Some note\n'),
				});
				vi.mocked(services.data.forUser).mockReturnValue(store);
				vi.mocked(services.llm.complete).mockRejectedValue(new Error('Rate limited'));

				const ctx = createTestMessageContext();
				// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on notes module
				await notes.handleCommand!('/summarize', [], ctx);

				expect(services.telegram.send).toHaveBeenCalledWith(
					'test-user',
					expect.stringContaining('try again later'),
				);
			});

			it('should show billing-specific error when API credits exhausted', async () => {
				const store = createMockScopedStore({
					read: vi.fn().mockResolvedValue('- [10:00] Some note\n'),
				});
				vi.mocked(services.data.forUser).mockReturnValue(store);
				const billingError = Object.assign(new Error('Your credit balance is too low'), {
					status: 400,
				});
				vi.mocked(services.llm.complete).mockRejectedValue(billingError);

				const ctx = createTestMessageContext();
				// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on notes module
				await notes.handleCommand!('/summarize', [], ctx);

				const sentMessage = vi.mocked(services.telegram.send).mock.calls[0][1] as string;
				expect(sentMessage).toContain('credits are too low');
			});
		});
	});
});
