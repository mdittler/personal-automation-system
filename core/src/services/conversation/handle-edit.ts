/**
 * /edit command handler.
 *
 * Propose an LLM-assisted file edit, show a diff preview, and wait for the
 * user to Confirm or Cancel. The pending proposal is stashed in a shared
 * map so a Confirm tap re-fetches whichever proposal is current (a new
 * /edit call replaces the slot — confirming an old preview will no-op).
 */

import type { AppLogger } from '../../types/app-module.js';
import type { MessageContext, TelegramService } from '../../types/telegram.js';
import { escapeMarkdown } from '../../utils/escape-markdown.js';
import type { EditProposal, EditService } from '../edit/index.js';

export interface HandleEditDeps {
	editService?: EditService;
	telegram: TelegramService;
	logger: AppLogger;
	pendingEdits: Map<string, EditProposal>;
}

export async function handleEdit(
	args: string[],
	ctx: MessageContext,
	deps: HandleEditDeps,
): Promise<void> {
	const { editService, telegram, pendingEdits } = deps;
	if (!editService) {
		await telegram.send(ctx.userId, 'Edit service is not available.');
		return;
	}

	const description = args.join(' ').trim();
	if (!description) {
		await telegram.send(
			ctx.userId,
			'Usage: /edit <description of change>\nExample: /edit fix orange price at Costco to $4.99',
		);
		return;
	}

	const result = await editService.proposeEdit(description, ctx.userId);

	if (result.kind === 'error') {
		const messages: Record<string, string> = {
			no_match: 'No matching files found for that description.',
			ambiguous: 'Multiple files match — try being more specific.',
			access_denied: 'That file cannot be edited.',
			generation_failed: result.message,
		};
		await telegram.send(ctx.userId, messages[result.action] ?? result.message);
		return;
	}

	// Store the pending proposal and capture the unique ID. We use proposalId
	// (not beforeHash) because two proposals to the same unchanged file share
	// the same beforeHash, which would allow confirming one preview to apply
	// another's edit.
	pendingEdits.set(ctx.userId, result);
	const proposalId = result.proposalId;

	// Build diff preview message (plain text — sendOptions does not render Markdown)
	const diffText = result.diff ? result.diff : '(no diff available)';
	const previewMessage = `Edit preview for ${result.filePath}\n\n${diffText}\n\nApply this change?`;

	try {
		const choice = await telegram.sendOptions(ctx.userId, previewMessage, ['Confirm', 'Cancel']);

		if (choice === 'Confirm') {
			// Re-fetch the stored proposal and verify it matches THIS preview.
			const proposal = pendingEdits.get(ctx.userId);
			if (!proposal) {
				await telegram.send(ctx.userId, 'No pending edit found.');
				return;
			}
			if (proposal.proposalId !== proposalId) {
				await telegram.send(
					ctx.userId,
					'This edit was superseded by a newer /edit request. Please retry.',
				);
				return;
			}
			pendingEdits.delete(ctx.userId);

			const confirmResult = await editService.confirmEdit(proposal);
			if (confirmResult.ok) {
				await telegram.send(ctx.userId, `✓ Applied to \`${escapeMarkdown(proposal.filePath)}\``);
			} else {
				await telegram.send(ctx.userId, `Edit failed: ${confirmResult.reason}`);
			}
		} else {
			pendingEdits.delete(ctx.userId);
			await telegram.send(ctx.userId, 'Edit cancelled.');
		}
	} catch {
		// sendOptions timed out or threw — map is cleaned up in finally
	} finally {
		// Only delete if the current map entry still belongs to THIS call.
		const current = pendingEdits.get(ctx.userId);
		if (current?.proposalId === proposalId) {
			pendingEdits.delete(ctx.userId);
		}
	}
}
