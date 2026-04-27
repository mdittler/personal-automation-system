/**
 * ConversationSystemInfoReader — thin wrapper around gatherSystemData.
 *
 * Preserves the per-category admin-filtering semantics of the original
 * chatbot system-data helper exactly. Not a generic getSystemInfo() —
 * it is narrowly scoped to building the system data block for prompt injection.
 */

import type { AppLogger } from '../../types/app-module.js';
import type { SystemInfoService } from '../../types/system-info.js';
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
	 * @param args.question  The user's question (drives category detection via categorizeQuestion).
	 * @param args.isAdmin   Whether the caller has admin privileges.
	 * @returns Formatted multi-line text block, or empty string if no relevant data.
	 */
	async buildSystemDataBlock(args: { question: string; isAdmin: boolean }): Promise<string> {
		if (!args.question.trim()) return '';

		const categories = categorizeQuestion(args.question);
		if (categories.size === 0) return '';

		try {
			return await gatherSystemData(
				this.systemInfo,
				categories,
				args.question,
				undefined, // userId only needed for per-user cost display; caller passes via requestContext
				args.isAdmin,
			);
		} catch (err) {
			this.logger?.warn('ConversationSystemInfoReader: gatherSystemData failed', err);
			return '';
		}
	}
}
