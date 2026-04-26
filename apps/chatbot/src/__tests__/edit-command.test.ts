/**
 * Tests for the /edit command handler (core implementation).
 *
 * The chatbot shim no longer exports handleCommand — /edit is now a Router
 * built-in that delegates to ConversationService.handleEdit → coreHandleEdit.
 * These tests import the core handler directly to keep coverage of the handler's
 * full logic (proposeEdit, confirmEdit, diff preview, pendingEdits map cleanup).
 *
 * Covers:
 * - No args → help message
 * - proposeEdit returns no_match → user-friendly message
 * - proposeEdit returns valid proposal → diff preview + sendOptions
 * - User selects Confirm → confirmEdit called → success message
 * - User selects Cancel → no confirmEdit, "cancelled" message
 * - editService undefined → "not available"
 */

import type { EditProposal, EditService } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEdit } from '@pas/core/services/conversation';
import { pendingEdits } from '@pas/core/services/conversation';
import { createTestMessageContext } from '../../../../core/src/testing/test-helpers.js';
import type { MessageContext } from '@pas/core/types';

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
		proposalId: 'prop-test',
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

function makeTelegram() {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue('Cancel'),
		sendPhoto: vi.fn(),
		sendWithButtons: vi.fn(),
		editMessage: vi.fn(),
	};
}

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}

function makeCtx(text: string): MessageContext {
	return createTestMessageContext({ text });
}

function makeDeps(editService?: EditService) {
	return {
		editService,
		telegram: makeTelegram(),
		logger: makeLogger(),
		pendingEdits,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/edit command (core handler)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		pendingEdits.clear();
	});

	describe('editService unavailable', () => {
		it('sends "not available" when editService is undefined', async () => {
			const deps = makeDeps(undefined);
			await handleEdit([], makeCtx('/edit fix something'), deps);
			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', expect.stringContaining('not available'));
		});
	});

	describe('no args', () => {
		it('sends usage help when /edit called with no description', async () => {
			const editService = makeEditService();
			const deps = makeDeps(editService);
			await handleEdit([], makeCtx('/edit'), deps);
			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', expect.stringContaining('Usage:'));
			expect(editService.proposeEdit).not.toHaveBeenCalled();
		});

		it('sends usage help when /edit args are only whitespace', async () => {
			const editService = makeEditService();
			const deps = makeDeps(editService);
			await handleEdit(['  '], makeCtx('/edit   '), deps);
			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', expect.stringContaining('Usage:'));
		});
	});

	describe('proposeEdit returns error', () => {
		it('sends no_match error as user-friendly message', async () => {
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue({ kind: 'error', action: 'no_match', message: 'No match' }),
			});
			const deps = makeDeps(editService);
			await handleEdit(['fix something'], makeCtx('/edit fix something'), deps);
			expect(editService.proposeEdit).toHaveBeenCalledWith('fix something', 'test-user');
			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', expect.stringContaining('No matching files'));
		});

		it('sends ambiguous error as user-friendly message', async () => {
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue({ kind: 'error', action: 'ambiguous', message: 'Multiple files match' }),
			});
			const deps = makeDeps(editService);
			await handleEdit(['fix something'], makeCtx('/edit fix something'), deps);
			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', expect.stringContaining('more specific'));
		});

		it('sends access_denied error as user-friendly message', async () => {
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue({ kind: 'error', action: 'access_denied', message: 'Read-only' }),
			});
			const deps = makeDeps(editService);
			await handleEdit(['fix something'], makeCtx('/edit fix something'), deps);
			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', expect.stringContaining('cannot be edited'));
		});

		it('sends generation_failed message verbatim', async () => {
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue({ kind: 'error', action: 'generation_failed', message: 'LLM output too large.' }),
			});
			const deps = makeDeps(editService);
			await handleEdit(['fix something'], makeCtx('/edit fix something'), deps);
			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', 'LLM output too large.');
		});
	});

	describe('valid proposal — Confirm flow', () => {
		it('calls sendOptions with Confirm/Cancel when proposal is valid', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({ proposeEdit: vi.fn().mockResolvedValue(proposal) });
			const deps = makeDeps(editService);
			deps.telegram.sendOptions = vi.fn().mockResolvedValue('Confirm');
			deps.telegram.send = vi.fn().mockResolvedValue(undefined);
			vi.mocked(editService.confirmEdit).mockResolvedValue({ ok: true });

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(deps.telegram.sendOptions).toHaveBeenCalledWith(
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
			const deps = makeDeps(editService);
			deps.telegram.sendOptions = vi.fn().mockResolvedValue('Confirm');

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(editService.confirmEdit).toHaveBeenCalledWith(proposal);
		});

		it('sends success message after successful confirm', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
				confirmEdit: vi.fn().mockResolvedValue({ ok: true }),
			});
			const deps = makeDeps(editService);
			deps.telegram.sendOptions = vi.fn().mockResolvedValue('Confirm');

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', expect.stringContaining('Applied'));
		});

		it('sends failure reason when confirmEdit returns ok: false', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
				confirmEdit: vi.fn().mockResolvedValue({ ok: false, reason: 'File was modified since the proposal was generated.' }),
			});
			const deps = makeDeps(editService);
			deps.telegram.sendOptions = vi.fn().mockResolvedValue('Confirm');

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', expect.stringContaining('File was modified'));
		});
	});

	describe('Cancel flow', () => {
		it('does NOT call confirmEdit when user selects Cancel', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
				confirmEdit: vi.fn(),
			});
			const deps = makeDeps(editService);
			deps.telegram.sendOptions = vi.fn().mockResolvedValue('Cancel');

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(editService.confirmEdit).not.toHaveBeenCalled();
		});

		it('sends cancelled message when user selects Cancel', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({ proposeEdit: vi.fn().mockResolvedValue(proposal) });
			const deps = makeDeps(editService);
			deps.telegram.sendOptions = vi.fn().mockResolvedValue('Cancel');

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(deps.telegram.send).toHaveBeenCalledWith('test-user', expect.stringContaining('cancelled'));
		});
	});

	describe('diff preview formatting', () => {
		it('includes file path in preview message', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({ proposeEdit: vi.fn().mockResolvedValue(proposal) });
			const deps = makeDeps(editService);

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(deps.telegram.sendOptions).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('costco.md'),
				['Confirm', 'Cancel'],
			);
		});

		it('shows "no diff available" when diff is empty', async () => {
			const proposal = makeProposal({ diff: '' });
			const editService = makeEditService({ proposeEdit: vi.fn().mockResolvedValue(proposal) });
			const deps = makeDeps(editService);

			await handleEdit(['fix something'], makeCtx('/edit fix something'), deps);

			expect(deps.telegram.sendOptions).toHaveBeenCalledWith(
				'test-user',
				expect.stringContaining('no diff available'),
				['Confirm', 'Cancel'],
			);
		});
	});

	describe('description extraction', () => {
		it('passes args joined as description to proposeEdit', async () => {
			const editService = makeEditService();
			const deps = makeDeps(editService);

			await handleEdit(['fix', 'orange', 'price', 'to', '$4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(editService.proposeEdit).toHaveBeenCalledWith('fix orange price to $4.99', 'test-user');
		});
	});

	describe('pendingEdits map cleanup', () => {
		it('removes the pending edit from the map when sendOptions throws (timeout/exception)', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({ proposeEdit: vi.fn().mockResolvedValue(proposal) });
			const deps = makeDeps(editService);
			deps.telegram.sendOptions = vi.fn().mockRejectedValue(new Error('Timeout'));

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(pendingEdits.has('test-user')).toBe(false);
		});

		it('stale call finally block does NOT delete a newer proposal from the map (Bug 1 fix)', async () => {
			const proposalA = makeProposal({ proposalId: 'id-A', description: 'edit A' });
			const proposalB = makeProposal({ proposalId: 'id-B', description: 'edit B' });

			const editService = makeEditService({ proposeEdit: vi.fn().mockResolvedValue(proposalA) });
			const deps = makeDeps(editService);

			deps.telegram.sendOptions = vi.fn().mockImplementation(async () => {
				pendingEdits.set('test-user', proposalB);
				return 'Confirm';
			});

			await handleEdit(['edit A'], makeCtx('/edit edit A'), deps);

			// B must still be in the map (A's finally block should not delete B's slot)
			expect(pendingEdits.get('test-user')).toBe(proposalB);
		});

		it('removes the pending edit from the map after a successful Confirm', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({
				proposeEdit: vi.fn().mockResolvedValue(proposal),
				confirmEdit: vi.fn().mockResolvedValue({ ok: true }),
			});
			const deps = makeDeps(editService);
			deps.telegram.sendOptions = vi.fn().mockResolvedValue('Confirm');

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(pendingEdits.has('test-user')).toBe(false);
		});

		it('removes the pending edit from the map after Cancel', async () => {
			const proposal = makeProposal();
			const editService = makeEditService({ proposeEdit: vi.fn().mockResolvedValue(proposal) });
			const deps = makeDeps(editService);
			deps.telegram.sendOptions = vi.fn().mockResolvedValue('Cancel');

			await handleEdit(['fix orange price to $4.99'], makeCtx('/edit fix orange price to $4.99'), deps);

			expect(pendingEdits.has('test-user')).toBe(false);
		});
	});
});
