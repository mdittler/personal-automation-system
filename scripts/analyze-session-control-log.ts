#!/usr/bin/env tsx
/**
 * analyze-session-control-log.ts
 *
 * Parses data/system/conversation/session-control-log.md and prints
 * classification and confirmation statistics for the SessionControlClassifier.
 *
 * Usage:
 *   pnpm analyze-session-control-log [--log <path>]
 *
 * Exported for unit testing: parseSessionControlLog, analyzeSessionControlLog.
 *
 * REQ-CONV-NEWCHAT-012.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedClassificationEntry {
	kind: 'classification';
	timestamp: string;
	userId: string;
	messageText: string;
	preFilter: string;
	llm: string;
	zone: 'high-confidence' | 'grey-zone' | 'below-threshold' | 'wrong-intent' | string;
	entryId?: string;
	latencyMs?: number;
}

export interface ParsedConfirmationEntry {
	kind: 'confirmation';
	timestamp: string;
	userId: string;
	entryId: string;
	outcome: 'confirmed' | 'declined' | 'expired-or-stale' | string;
	elapsedMs?: number;
}

export type ParsedEntry = ParsedClassificationEntry | ParsedConfirmationEntry;

export interface SessionControlStats {
	total: number;
	classificationCount: number;
	confirmationCount: number;
	zoneCounts: Record<string, number>;
	/** Confirmation rate for grey-zone entries (confirmed / (confirmed + declined)). NaN when denominator is 0. */
	greyZoneConfirmationRate: number;
	/** Top N declined messages (messageText from linked classification entries). */
	topDeclinedMessages: Array<{ message: string; count: number }>;
	outcomeCounts: Record<string, number>;
}

// ─── Entry parser ─────────────────────────────────────────────────────────────

/**
 * Parses one "## …" block from the session-control log into a structured entry.
 * Returns null for empty or unrecognized blocks.
 */
export function parseSessionControlLogEntry(block: string): ParsedEntry | null {
	if (!block.trim() || !block.startsWith('## ')) return null;

	const lines = block.split('\n');
	const timestamp = lines[0]!.slice(3).trim();

	const kv = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const m = line.match(/^- \*\*([^*]+)\*\*:\s*(.*)$/);
		if (m) kv.set(m[1]!.trim(), m[2]!.trim());
	}

	const kind = kv.get('Kind');

	if (kind === 'classification') {
		const latencyRaw = kv.get('Latency');
		const latencyMs = latencyRaw ? Number.parseInt(latencyRaw, 10) : undefined;
		const rawMessage = kv.get('Message') ?? '';
		let messageText = rawMessage;
		if (rawMessage.startsWith('"') && rawMessage.endsWith('"') && rawMessage.length >= 2) {
			try {
				messageText = JSON.parse(rawMessage) as string;
			} catch {
				/* keep raw */
			}
		}
		return {
			kind: 'classification',
			timestamp,
			userId: kv.get('User') ?? '',
			messageText,
			preFilter: kv.get('Pre-filter') ?? '',
			llm: kv.get('LLM') ?? '',
			zone: kv.get('Zone') ?? '',
			entryId: kv.get('Entry ID') || undefined,
			latencyMs: latencyMs !== undefined && !isNaN(latencyMs) ? latencyMs : undefined,
		};
	}

	if (kind === 'confirmation') {
		const elapsedRaw = kv.get('Elapsed');
		const elapsedMs = elapsedRaw ? Number.parseInt(elapsedRaw, 10) : undefined;
		return {
			kind: 'confirmation',
			timestamp,
			userId: kv.get('User') ?? '',
			entryId: kv.get('Entry ID') ?? '',
			outcome: kv.get('Outcome') ?? '',
			elapsedMs: elapsedMs !== undefined && !isNaN(elapsedMs) ? elapsedMs : undefined,
		};
	}

	return null;
}

/**
 * Parses an entire session-control log markdown file into structured entries.
 */
export function parseSessionControlLog(markdown: string): ParsedEntry[] {
	const blocks = markdown.split(/\n(?=## )/).filter((b) => b.startsWith('## '));
	return blocks.map(parseSessionControlLogEntry).filter((e): e is ParsedEntry => e !== null);
}

// ─── Analyzer ─────────────────────────────────────────────────────────────────

export function analyzeSessionControlLog(entries: ParsedEntry[]): SessionControlStats {
	const classifications = entries.filter(
		(e): e is ParsedClassificationEntry => e.kind === 'classification',
	);
	const confirmations = entries.filter(
		(e): e is ParsedConfirmationEntry => e.kind === 'confirmation',
	);

	// Zone counts
	const zoneCounts: Record<string, number> = {};
	for (const e of classifications) {
		zoneCounts[e.zone] = (zoneCounts[e.zone] ?? 0) + 1;
	}

	// Outcome counts
	const outcomeCounts: Record<string, number> = {};
	for (const e of confirmations) {
		outcomeCounts[e.outcome] = (outcomeCounts[e.outcome] ?? 0) + 1;
	}

	// Grey-zone confirmation rate — only count confirmations linked to grey-zone classifications
	const greyZoneEntryIds = new Set(
		classifications.filter((e) => e.zone === 'grey-zone' && e.entryId).map((e) => e.entryId!),
	);
	const greyZoneConfirmed = confirmations.filter(
		(e) => e.outcome === 'confirmed' && e.entryId && greyZoneEntryIds.has(e.entryId),
	).length;
	const greyZoneDeclined = confirmations.filter(
		(e) => e.outcome === 'declined' && e.entryId && greyZoneEntryIds.has(e.entryId),
	).length;
	const greyZoneDenominator = greyZoneConfirmed + greyZoneDeclined;
	const greyZoneConfirmationRate =
		greyZoneDenominator > 0 ? greyZoneConfirmed / greyZoneDenominator : Number.NaN;

	// Top declined messages — link confirmation entryId → classification messageText
	const entryIdToMessage = new Map<string, string>();
	for (const e of classifications) {
		if (e.entryId) {
			entryIdToMessage.set(e.entryId, e.messageText);
		}
	}

	const declinedMessageCounts = new Map<string, number>();
	for (const e of confirmations) {
		if (e.outcome === 'declined' && e.entryId) {
			const msg = entryIdToMessage.get(e.entryId) ?? e.entryId;
			declinedMessageCounts.set(msg, (declinedMessageCounts.get(msg) ?? 0) + 1);
		}
	}

	const topDeclinedMessages = Array.from(declinedMessageCounts.entries())
		.map(([message, count]) => ({ message, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 20);

	return {
		total: entries.length,
		classificationCount: classifications.length,
		confirmationCount: confirmations.length,
		zoneCounts,
		greyZoneConfirmationRate,
		topDeclinedMessages,
		outcomeCounts,
	};
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			log: {
				type: 'string',
				default: 'data/system/conversation/session-control-log.md',
			},
		},
	});

	const logPath = resolve(process.cwd(), values.log!);
	let md: string;
	try {
		md = await readFile(logPath, 'utf8');
	} catch (err) {
		console.error(`Could not read log at ${logPath}: ${String(err)}`);
		process.exit(1);
	}

	const entries = parseSessionControlLog(md);
	const stats = analyzeSessionControlLog(entries);

	console.log(`Session control classifier log: ${logPath}`);
	console.log(`Total entries: ${stats.total}`);
	console.log(`  Classifications: ${stats.classificationCount}`);
	console.log(`  Confirmations:   ${stats.confirmationCount}`);

	if (stats.classificationCount > 0) {
		console.log('\nZone breakdown:');
		for (const [zone, count] of Object.entries(stats.zoneCounts).sort((a, b) => b[1] - a[1])) {
			const pct = ((count / stats.classificationCount) * 100).toFixed(1);
			console.log(`  ${zone.padEnd(20)}: ${count}  (${pct}%)`);
		}
	}

	if (stats.confirmationCount > 0) {
		console.log('\nConfirmation outcomes:');
		for (const [outcome, count] of Object.entries(stats.outcomeCounts).sort(
			(a, b) => b[1] - a[1],
		)) {
			console.log(`  ${outcome.padEnd(20)}: ${count}`);
		}

		if (!isNaN(stats.greyZoneConfirmationRate)) {
			console.log(
				`\nGrey-zone confirmation rate: ${(stats.greyZoneConfirmationRate * 100).toFixed(1)}%` +
					` (${stats.outcomeCounts['confirmed'] ?? 0} confirmed /` +
					` ${(stats.outcomeCounts['confirmed'] ?? 0) + (stats.outcomeCounts['declined'] ?? 0)} resolved)`,
			);
		}
	}

	if (stats.topDeclinedMessages.length > 0) {
		console.log('\nTop declined messages:');
		for (const d of stats.topDeclinedMessages) {
			console.log(`  ×${d.count}  "${d.message}"`);
		}
	}
}

const isMain =
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith('analyze-session-control-log.ts') ||
	process.argv[1]?.endsWith('analyze-session-control-log.js');

if (isMain) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
