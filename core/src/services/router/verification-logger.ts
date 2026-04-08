/**
 * VerificationLogger — appends grey-zone classification events to a markdown log file.
 *
 * Used for observability: helps tune intent descriptions and confidence thresholds
 * by recording what happened with grey-zone classifications.
 */

import { appendFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ensureDir } from '../../utils/file.js';

export interface VerificationLogEntry {
	timestamp: Date;
	userId: string;
	messageText: string;
	messageType: 'text' | 'photo';
	photoPath?: string;
	classifierAppId: string;
	classifierConfidence: number;
	classifierIntent: string;
	verifierAgrees: boolean;
	verifierSuggestedAppId?: string;
	verifierSuggestedIntent?: string;
	userChoice?: string;
	outcome: 'auto' | 'user override' | 'pending';
	routedTo: string;
}

const FRONTMATTER = `---
title: Route Verification Log
type: system-log
tags: [pas/route-verification]
---

`;

/**
 * Format a Date as "YYYY-MM-DD HH:MM:SS" from its ISO representation.
 * Uses UTC time (ISO string already normalises to UTC).
 */
function formatTimestamp(date: Date): string {
	return date.toISOString().replace('T', ' ').substring(0, 19);
}

export class VerificationLogger {
	private readonly logPath: string;

	constructor(dataDir: string) {
		this.logPath = join(dataDir, 'route-verification-log.md');
	}

	async log(entry: VerificationLogEntry): Promise<void> {
		await ensureDir(dirname(this.logPath));

		const block = this.formatEntry(entry);

		// Atomically create with frontmatter, or just append if file already exists
		try {
			await writeFile(this.logPath, FRONTMATTER + block, { flag: 'wx', encoding: 'utf-8' });
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
				await appendFile(this.logPath, block, 'utf-8');
			} else {
				throw err;
			}
		}
	}

	private formatEntry(entry: VerificationLogEntry): string {
		const ts = formatTimestamp(entry.timestamp);
		const text = entry.messageText.substring(0, 200);
		const confidence = entry.classifierConfidence;

		const lines: string[] = [
			`## ${ts}`,
			'',
			`- **Message**: "${text}"`,
			`- **Type**: ${entry.messageType}`,
		];

		if (entry.messageType === 'photo' && entry.photoPath !== undefined) {
			const filename = basename(entry.photoPath);
			lines.push(`- **Photo**: [${filename}](${entry.photoPath})`);
		}

		lines.push(`- **User**: ${entry.userId}`);
		lines.push(
			`- **Classifier**: ${entry.classifierAppId} (confidence: ${confidence}, intent: "${entry.classifierIntent}")`,
		);

		if (entry.verifierAgrees) {
			lines.push(`- **Verifier**: ${entry.classifierAppId} (agrees)`);
		} else {
			const suggested = entry.verifierSuggestedAppId ?? 'none';
			const suggestedIntent = entry.verifierSuggestedIntent;
			if (suggestedIntent !== undefined) {
				lines.push(`- **Verifier**: ${suggested} (disagrees, suggests: "${suggestedIntent}")`);
			} else {
				lines.push(`- **Verifier**: ${suggested} (disagrees)`);
			}
			if (entry.userChoice !== undefined) {
				lines.push(`- **User choice**: ${entry.userChoice}`);
			}
		}

		lines.push(`- **Outcome**: routed to ${entry.routedTo} (${entry.outcome})`);
		lines.push('');
		lines.push('');

		return lines.join('\n');
	}
}
