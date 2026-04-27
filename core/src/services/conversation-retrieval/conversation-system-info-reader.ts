/**
 * ConversationSystemInfoReader — thin wrapper around gatherSystemData.
 *
 * Preserves the per-category admin-filtering semantics of the original
 * chatbot system-data helper exactly. Not a generic getSystemInfo() —
 * it is narrowly scoped to building the system data block for prompt injection.
 *
 * Admin status and userId are derived from requestContext rather than
 * accepted as caller parameters — this prevents callers from accidentally
 * escalating privileges.
 */

import type { AppLogger } from '../../types/app-module.js';
import type { SystemInfoService } from '../../types/system-info.js';
import { getCurrentUserId } from '../context/request-context.js';
import { categorizeQuestion, gatherSystemData } from '../conversation/system-data.js';

export class ConversationSystemInfoReader {
	constructor(
		private readonly systemInfo: SystemInfoService,
		private readonly logger?: AppLogger,
	) {}

	/**
	 * Build a formatted system data block for LLM prompt injection.
	 *
	 * Delegates to gatherSystemData() which applies per-category admin filtering:
	 *   - Non-admin: sees tier models (no provider/pricing), own cost line, basic system status
	 *   - Admin: sees full pricing, per-app/per-user costs, cron jobs, safeguard config
	 *
	 * Admin status is derived from SystemInfoService.isUserAdmin using the current
	 * requestContext userId — not accepted from the caller.
	 *
	 * @param args.question  The user's question (drives category detection via categorizeQuestion).
	 * @returns Formatted multi-line text block, or empty string if no relevant data.
	 */
	async buildSystemDataBlock(args: { question: string }): Promise<string> {
		if (!args.question.trim()) return '';

		const categories = categorizeQuestion(args.question);
		if (categories.size === 0) return '';

		const userId = getCurrentUserId();
		const isAdmin = userId ? this.systemInfo.isUserAdmin(userId) : false;

		try {
			return await gatherSystemData(
				this.systemInfo,
				categories,
				args.question,
				userId,
				isAdmin,
			);
		} catch (err) {
			this.logger?.warn('ConversationSystemInfoReader: gatherSystemData failed', err);
			return '';
		}
	}
}
