/**
 * Tests for the /edit command in the chatbot app.
 *
 * Covers:
 * - No args → help message
 * - proposeEdit returns no_match → user-friendly message
 * - proposeEdit returns valid proposal → diff preview + sendOptions
 * - User selects Confirm → confirmEdit called → success message
 * - User selects Cancel → no confirmEdit, "cancelled" message
 * - editService undefined → "not available"
 */

import type { CoreServices, MessageContext, EditProposal, EditService } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices } from '../../../../core/src/testing/mock-services.js';
import { createTestMessageContext } from '../../../../core/src/testing/test-helpers.js';
import * as chatbot from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEditService(overrides?: Partial<EditService>): EditService {
	return {
		proposeEdit: vi.fn().mockResolvedValue({ kind: 'error', action: 'no_match', message: 'No match' }),
		confirmEdit: vi.fn().mockResolvedValue({ ok: true }),
		...overrides,
	};
}

function makeProposal(overrides?: Partial<EditProposal>): EditProposal {
	return {
		kind: 'proposal',
		filePath: 'users/test-user/food/prices/costco.md',
		absolutePath: '/data/users/test-user/food/prices/costco.md',
		appId: 'food',
		userId: 'test-user',
		description: 'fix orange price to $4.99',
		scope: 'user',
		beforeContent: '# Costco Prices\n\n- Orange: $5.99',
		afterContent: '# Costco Prices\n\n- Orange: $4.99',
		beforeHash: 'abc123',
		diff: '--- a/costco.md\n+++ b/costco.md\n@@ -1 +1 @@\n-Orange: $5.99\n+Orange: $4.99',
		expiresAt: new Date(Date.now() + 5 * 60 * 1000),
		...overrides,
	};
}

function makeServicesWithEdit(editService?: EditService): CoreServices {
	const services = createMockCoreServices({
		interactionContext: {},
	});
	return { ...services, editService };
}

function makeCtx(text: string): MessageContext {
	return createTestMessageContext({ text });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/edit command', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
	});

	describe('editService unavailable', () => {
		it('sends "not available" when editService is undefined', async () => {
			const services = makeServicesWithEdit(undefined);
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('not available'),
			);
		});
	});

	describe('no args', () => {
		it('sends usage help when /edit called with no description', async () => {
			const editService = makeEditService();
			const services = makeServicesWithEdit(editService);
			await chatbot.init(services);

			const ctx = makeCtx('/edit');
			await chatbot.handleCommand('/edit', [], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('Usage:'),
			);
			expect(editService.proposeEdit).not.toHaveBeenCalled();
		});

		it('sends usage help when /edit args are only whitespace', async () => {
			const editService = makeEditService();
			const services = makeServicesWithEdit(editService);
			await chatbot.init(services);

			const ctx = makeCtx('/edit   ');
			await chatbot.handleCommand('/edit', ['  '], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('Usage:'),
			);
		});
	});

	describe('proposeEdit returns error', () => {
		it('sends no_match error as user-friendly message', async () => {
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue({ kind: 'error', action: 'no_match', message: 'No match' }),
			});
			const services = makeServicesWithEdit(editService);
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix something');
			await chatbot.handleCommand('/edit', ['fix something'], ctx);

			expect(editService.proposeEdit).toHaveBeenCalledWith('fix something', 'test-user');
			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('No matching files'),
			);
		});

		it('sends ambiguous error as user-friendly message', async () => {
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue({ kind: 'error', action: 'ambiguous', message: 'Multiple files match' }),
			});
			const services = makeServicesWithEdit(editService);
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix something');
			await chatbot.handleCommand('/edit', ['fix something'], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('more specific'),
			);
		});

		it('sends access_denied error as user-friendly message', async () => {
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue({ kind: 'error', action: 'access_denied', message: 'Read-only' }),
			});
			const services = makeServicesWithEdit(editService);
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix something');
			await chatbot.handleCommand('/edit', ['fix something'], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('cannot be edited'),
			);
		});

		it('sends generation_failed message verbatim', async () => {
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue({
					kind: 'error',
					action: 'generation_failed',
					message: 'LLM output too large.',
				}),
			});
			const services = makeServicesWithEdit(editService);
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix something');
			await chatbot.handleCommand('/edit', ['fix something'], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'LLM output too large.');
		});
	});

	describe('valid proposal — Confirm flow', () => {
		it('calls sendOptions with Confirm/Cancel when proposal is valid', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Confirm');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(services.telegram.sendOptions).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('Edit preview'),
				['Confirm', 'Cancel'],
			);
		});

		it('calls confirmEdit when user selects Confirm', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
				confirmEdit: vi.fn().mockResolvedValue({ ok: true }),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Confirm');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(editService.confirmEdit).toHaveBeenCalledWith(proposal);
		});

		it('sends success message after successful confirm', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
				confirmEdit: vi.fn().mockResolvedValue({ ok: true }),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Confirm');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('Applied'),
			);
		});

		it('sends failure reason when confirmEdit returns ok: false', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
				confirmEdit: vi.fn().mockResolvedValue({ ok: false, reason: 'File was modified since the proposal was generated.' }),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Confirm');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('File was modified'),
			);
		});
	});

	describe('Cancel flow', () => {
		it('does NOT call confirmEdit when user selects Cancel', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
				confirmEdit: vi.fn(),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Cancel');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(editService.confirmEdit).not.toHaveBeenCalled();
		});

		it('sends cancelled message when user selects Cancel', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Cancel');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('cancelled'),
			);
		});
	});

	describe('diff preview formatting', () => {
		it('includes file path in preview message', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Cancel');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(services.telegram.sendOptions).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('costco.md'),
				['Confirm', 'Cancel'],
			);
		});

		it('shows "no diff available" when diff is empty', async () => {
			const proposal = makeProposal({ diff: '' });
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Cancel');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix something');
			await chatbot.handleCommand('/edit', ['fix something'], ctx);

			expect(services.telegram.sendOptions).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('no diff available'),
				['Confirm', 'Cancel'],
			);
		});
	});

	describe('description extraction', () => {
		it('passes args joined as description to proposeEdit', async () => {
			const editService = makeEditService();
			const services = makeServicesWithEdit(editService);
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix', 'orange', 'price', 'to', '$4.99'], ctx);

			expect(editService.proposeEdit).toHaveBeenCalledWith(
				'fix orange price to $4.99',
				'test-user',
			);
		});
	});

	describe('pendingEdits map cleanup', () => {
		it('removes the pending edit from the map when sendOptions throws (timeout/exception)', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
			});
			const services = makeServicesWithEdit(editService);
			// Simulate sendOptions throwing (e.g. 5-minute TTL expired)
			vi.mocked(services.telegram.sendOptions).mockRejectedValue(new Error('Timeout'));
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			// The map must be empty — the finally block must have cleaned it up
			expect(chatbot.pendingEdits.has('test-user')).toBe(false);
		});

		it('removes the pending edit from the map after a successful Confirm', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
				confirmEdit: vi.fn().mockResolvedValue({ ok: true }),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Confirm');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(chatbot.pendingEdits.has('test-user')).toBe(false);
		});

		it('removes the pending edit from the map after Cancel', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
			});
			const services = makeServicesWithEdit(editService);
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Cancel');
			await chatbot.init(services);

			const ctx = makeCtx('/edit fix orange price to $4.99');
			await chatbot.handleCommand('/edit', ['fix orange price to $4.99'], ctx);

			expect(chatbot.pendingEdits.has('test-user')).toBe(false);
		});
	});
});
