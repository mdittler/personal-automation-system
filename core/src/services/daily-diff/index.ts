/**
 * Daily diff service.
 *
 * Orchestrates the nightly change summary: reads the change log,
 * groups by app/user, optionally summarizes via LLM, and writes
 * a dated markdown report to data/system/daily-diff/.
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import type { LLMService } from '../../types/llm.js';
import { toDateString } from '../../utils/date.js';
import { atomicWrite, ensureDir } from '../../utils/file.js';
import { generateFrontmatter } from '../../utils/frontmatter.js';
import type { ChangeLog } from '../data-store/change-log.js';
import { collectChanges } from './collector.js';
import { summarizeChanges } from './summarizer.js';

export interface DailyDiffOptions {
	dataDir: string;
	changeLog: ChangeLog;
	llm: LLMService;
	logger: Logger;
	enableSummarization?: boolean;
}

export class DailyDiffService {
	private readonly dataDir: string;
	private readonly changeLog: ChangeLog;
	private readonly llm: LLMService;
	private readonly logger: Logger;
	private readonly enableSummarization: boolean;

	constructor(options: DailyDiffOptions) {
		this.dataDir = options.dataDir;
		this.changeLog = options.changeLog;
		this.llm = options.llm;
		this.logger = options.logger;
		this.enableSummarization = options.enableSummarization ?? false;
	}

	/**
	 * Run the daily diff for the last 24 hours (or since the given date).
	 * Writes a markdown report to data/system/daily-diff/<date>.md.
	 */
	async run(since?: Date): Promise<void> {
		const sinceDate = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
		const dateStr = toDateString(sinceDate);

		this.logger.info({ date: dateStr }, 'Running daily diff');

		const changes = await collectChanges(this.changeLog.getLogPath(), sinceDate);

		if (changes.entries.length === 0) {
			this.logger.info({ date: dateStr }, 'No changes to report');
			return;
		}

		let summary = 'No summary generated.';
		if (this.enableSummarization) {
			const llmSummary = await summarizeChanges(changes, this.llm, this.logger);
			if (llmSummary) {
				summary = llmSummary;
			}
		}

		const markdown = formatReport(dateStr, summary, changes.byApp);

		const frontmatter = generateFrontmatter({
			title: `Daily Diff - ${dateStr}`,
			date: dateStr,
			tags: ['pas/daily-diff'],
			type: 'diff',
			source: 'pas-daily-diff',
		});

		const diffDir = join(this.dataDir, 'system', 'daily-diff');
		await ensureDir(diffDir);
		await atomicWrite(join(diffDir, `${dateStr}.md`), frontmatter + markdown);

		this.logger.info(
			{ date: dateStr, changeCount: changes.entries.length },
			'Daily diff report written',
		);
	}
}

/** Format grouped changes into a markdown report. */
function formatReport(
	date: string,
	summary: string,
	byApp: Record<string, Record<string, Array<{ operation: string; path: string }>>>,
): string {
	const lines: string[] = [`# Daily Diff — ${date}`, '', '## Summary', summary, '', '## Changes'];

	for (const [appId, users] of Object.entries(byApp)) {
		lines.push('', `### ${appId}`);
		for (const [userId, entries] of Object.entries(users)) {
			const ops = entries.map((e) => `${e.operation} ${e.path}`).join(', ');
			lines.push(`- **${userId}**: ${ops}`);
		}
	}

	lines.push('');
	return lines.join('\n');
}

export { collectChanges } from './collector.js';
export { summarizeChanges } from './summarizer.js';
export type { DailyChanges } from './collector.js';
