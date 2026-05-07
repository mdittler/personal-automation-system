/**
 * SessionControlLogger — structured markdown log for the SessionControlClassifier.
 *
 * Mirrors apps/food/src/routing/shadow-logger.ts.
 * Two event types:
 *   (a) classification — written from Router.handleSessionControlHook
 *   (b) confirmation   — written from handleSessionControlCallback (sc:yes / sc:no)
 *
 * Promise-chain serialization prevents interleaved writes.
 * Fail-open: errors are logged via the constructor logger; callers never throw.
 *
 * REQ-CONV-NEWCHAT-009..011.
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppLogger } from '../../types/app-module.js';

export type PreFilterOutcome = 'matched' | 'unmatched';

export interface SessionControlClassificationEntry {
	timestamp: Date;
	userId: string;
	messageText: string;
	preFilter: PreFilterOutcome;
	llm:
		| { intent: string; confidence: number; reason: string; source: 'llm' | 'prefilter' }
		| 'skipped';
	zone: 'high-confidence' | 'grey-zone' | 'below-threshold' | 'wrong-intent';
	entryId?: string;
	latencyMs: number;
}

export interface SessionControlConfirmationEntry {
	timestamp: Date;
	userId: string;
	entryId: string;
	outcome: 'confirmed' | 'declined' | 'expired-or-stale' | 'failed';
	elapsedMs: number;
}

export interface SessionControlLoggerOptions {
	enabled?: boolean;
}

const FRONTMATTER = `---\ntitle: Session Control Classifier Log\ntype: system-log\ntags: [pas/session-control-classifier]\n---\n\n`;
const MAX_MSG = 200;

// Bidi control character ranges:
//   U+202A..U+202E  (LRE, RLE, PDF, LRO, RLO)
//   U+2066..U+2069  (LRI, RLI, FSI, PDI)
//   U+200B..U+200F  (ZWSP, ZWNJ, ZWJ, LRM, RLM)
const BIDI_CC_RE = /[‪-‮⁦-⁩​-‏]/g;

function fmtTs(d: Date): string {
	return d.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Make a raw string safe for embedding in a markdown log file.
 *
 * Steps (order matters):
 *  1. Strip bidi controls (replacement before truncation so we count clean code points)
 *  2. Strip dangerous closing tags
 *  3. Replace backticks (would break markdown code fences)
 *  4. Collapse newlines to a single space
 *  5. Code-point-correct truncation (Array.from preserves emoji)
 *  6. JSON-escape remaining special chars (quotes, backslashes, control chars)
 */
function safeForLog(raw: string, maxCodePoints: number): string {
	const noBidi = raw.replace(BIDI_CC_RE, '[bidi]');
	const noTags = noBidi
		.replace(/<script/gi, '[script')
		.replace(/<\/script>/gi, '[/script]')
		.replace(/<style/gi, '[style')
		.replace(/<\/style>/gi, '[/style]');
	const noTicks = noTags.replace(/`/g, "'");
	const oneLine = noTicks.replace(/[\r\n]+/g, ' ');
	const truncated = Array.from(oneLine).slice(0, maxCodePoints).join('');
	return JSON.stringify(truncated).slice(1, -1);
}

export class SessionControlLogger {
	private readonly logPath: string;
	private writeChain: Promise<void> = Promise.resolve();
	private readonly enabled: boolean;

	constructor(
		dataDir: string,
		private readonly logger: AppLogger,
		opts: SessionControlLoggerOptions = {},
	) {
		this.logPath = join(dataDir, 'session-control-log.md');
		this.enabled = opts.enabled ?? true;
	}

	logClassification(entry: SessionControlClassificationEntry): Promise<void> {
		if (!this.enabled) return Promise.resolve();
		const next = this.writeChain.then(() => this.doWrite(this.formatClassification(entry)));
		this.writeChain = next.catch(() => undefined);
		return next;
	}

	logConfirmation(entry: SessionControlConfirmationEntry): Promise<void> {
		if (!this.enabled) return Promise.resolve();
		const next = this.writeChain.then(() => this.doWrite(this.formatConfirmation(entry)));
		this.writeChain = next.catch(() => undefined);
		return next;
	}

	private async doWrite(block: string): Promise<void> {
		try {
			await mkdir(dirname(this.logPath), { recursive: true });
			try {
				await writeFile(this.logPath, FRONTMATTER + block, {
					flag: 'wx',
					encoding: 'utf-8',
				});
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
					await appendFile(this.logPath, block, 'utf-8');
				} else {
					throw err;
				}
			}
		} catch (err) {
			this.logger.warn(`session-control-logger write failed: ${String(err)}`);
		}
	}

	private formatClassification(e: SessionControlClassificationEntry): string {
		const text = safeForLog(e.messageText, MAX_MSG);
		const llmStr = e.llm === 'skipped' ? 'skipped' : JSON.stringify(e.llm);
		const lines: Array<string | null> = [
			`## ${fmtTs(e.timestamp)}`,
			'',
			`- **Kind**: classification`,
			`- **User**: ${e.userId}`,
			`- **Message**: "${text}"`,
			`- **Pre-filter**: ${e.preFilter}`,
			`- **LLM**: ${llmStr}`,
			`- **Zone**: ${e.zone}`,
			e.entryId ? `- **Entry ID**: ${e.entryId}` : null,
			`- **Latency**: ${e.latencyMs}ms`,
			'',
			'',
		];
		return lines.filter((l): l is string => l !== null).join('\n');
	}

	private formatConfirmation(e: SessionControlConfirmationEntry): string {
		return [
			`## ${fmtTs(e.timestamp)}`,
			'',
			`- **Kind**: confirmation`,
			`- **User**: ${e.userId}`,
			`- **Entry ID**: ${e.entryId}`,
			`- **Outcome**: ${e.outcome}`,
			`- **Elapsed**: ${e.elapsedMs}ms`,
			'',
			'',
		].join('\n');
	}
}
