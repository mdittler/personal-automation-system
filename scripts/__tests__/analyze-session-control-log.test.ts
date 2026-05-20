/**
 * Unit tests for analyze-session-control-log.ts
 *
 * Covers: entry parsing, analyzer statistics, round-trip with real SessionControlLogger.
 *
 * REQ-CONV-NEWCHAT-012.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionControlLogger } from '../../core/src/services/conversation/session-control-logger.js';
import {
	type ParsedClassificationEntry,
	type ParsedConfirmationEntry,
	analyzeSessionControlLog,
	parseSessionControlLog,
	parseSessionControlLogEntry,
} from '../analyze-session-control-log.js';

// ─── Synthetic log fixture ────────────────────────────────────────────────────

const FRONTMATTER = `---
title: Session Control Classifier Log
type: system-log
tags: [pas/session-control-classifier]
---

`;

function makeClassificationBlock(opts: {
	ts?: string;
	userId?: string;
	message?: string;
	preFilter?: string;
	llm?: string;
	zone?: string;
	entryId?: string;
	latency?: string;
}) {
	const ts = opts.ts ?? '2026-05-07 10:00:00';
	const lines = [
		`## ${ts}`,
		'',
		'- **Kind**: classification',
		`- **User**: ${opts.userId ?? 'u1'}`,
		`- **Message**: "${opts.message ?? 'start fresh'}"`,
		`- **Pre-filter**: ${opts.preFilter ?? 'unmatched'}`,
		`- **LLM**: ${opts.llm ?? '{"intent":"new_session","confidence":0.55,"reason":"ambiguous","source":"llm"}'}`,
		`- **Zone**: ${opts.zone ?? 'grey-zone'}`,
		...(opts.entryId ? [`- **Entry ID**: ${opts.entryId}`] : []),
		`- **Latency**: ${opts.latency ?? '42ms'}`,
		'',
		'',
	];
	return lines.join('\n');
}

function makeConfirmationBlock(opts: {
	ts?: string;
	userId?: string;
	entryId?: string;
	outcome?: string;
	elapsed?: string;
}) {
	return [
		`## ${opts.ts ?? '2026-05-07 10:01:00'}`,
		'',
		'- **Kind**: confirmation',
		`- **User**: ${opts.userId ?? 'u1'}`,
		`- **Entry ID**: ${opts.entryId ?? 'abc123'}`,
		`- **Outcome**: ${opts.outcome ?? 'confirmed'}`,
		`- **Elapsed**: ${opts.elapsed ?? '3500ms'}`,
		'',
		'',
	].join('\n');
}

// ─── parseSessionControlLogEntry ─────────────────────────────────────────────

describe('parseSessionControlLogEntry', () => {
	it('parses a classification block', () => {
		const block = makeClassificationBlock({ entryId: 'abc123', latency: '42ms' });
		const entry = parseSessionControlLogEntry(block);
		expect(entry).not.toBeNull();
		expect(entry!.kind).toBe('classification');
		const c = entry as ParsedClassificationEntry;
		expect(c.userId).toBe('u1');
		expect(c.zone).toBe('grey-zone');
		expect(c.entryId).toBe('abc123');
		expect(c.latencyMs).toBe(42);
		expect(c.preFilter).toBe('unmatched');
	});

	it('parses a confirmation block', () => {
		const block = makeConfirmationBlock({ outcome: 'declined', elapsed: '2000ms' });
		const entry = parseSessionControlLogEntry(block);
		expect(entry).not.toBeNull();
		expect(entry!.kind).toBe('confirmation');
		const c = entry as ParsedConfirmationEntry;
		expect(c.outcome).toBe('declined');
		expect(c.elapsedMs).toBe(2000);
		expect(c.entryId).toBe('abc123');
	});

	it('returns null for empty string', () => {
		expect(parseSessionControlLogEntry('')).toBeNull();
	});

	it('returns null for block with no Kind field', () => {
		const block = '## 2026-05-07 10:00:00\n\n- **User**: u1\n\n';
		expect(parseSessionControlLogEntry(block)).toBeNull();
	});

	it('handles missing optional fields gracefully', () => {
		const block = makeClassificationBlock({});
		const entry = parseSessionControlLogEntry(block) as ParsedClassificationEntry;
		expect(entry).not.toBeNull();
		expect(entry.entryId).toBeUndefined();
	});

	it('decodes messageText without surrounding quotes (P3-4)', () => {
		const block = makeClassificationBlock({ message: 'start fresh' });
		const entry = parseSessionControlLogEntry(block) as ParsedClassificationEntry;
		expect(entry.messageText).toBe('start fresh');
		expect(entry.messageText).not.toMatch(/^"/);
	});

	it('decodes messageText containing JSON-escaped double quotes', () => {
		// The logger JSON-escapes quotes inside the string; the parser must reverse this
		const block = `## 2026-05-07 10:00:00\n\n- **Kind**: classification\n- **User**: u1\n- **Message**: "hello \\"world\\""\n- **Pre-filter**: unmatched\n- **LLM**: skipped\n- **Zone**: grey-zone\n- **Latency**: 10ms\n\n`;
		const entry = parseSessionControlLogEntry(block) as ParsedClassificationEntry;
		expect(entry.messageText).toBe('hello "world"');
	});

	it('parses high-confidence zone', () => {
		const block = makeClassificationBlock({ zone: 'high-confidence' });
		const entry = parseSessionControlLogEntry(block) as ParsedClassificationEntry;
		expect(entry.zone).toBe('high-confidence');
	});

	it('parses below-threshold zone', () => {
		const block = makeClassificationBlock({ zone: 'below-threshold' });
		const entry = parseSessionControlLogEntry(block) as ParsedClassificationEntry;
		expect(entry.zone).toBe('below-threshold');
	});

	it('parses wrong-intent zone', () => {
		const block = makeClassificationBlock({ zone: 'wrong-intent' });
		const entry = parseSessionControlLogEntry(block) as ParsedClassificationEntry;
		expect(entry.zone).toBe('wrong-intent');
	});

	it('parses expired-or-stale outcome', () => {
		const block = makeConfirmationBlock({ outcome: 'expired-or-stale' });
		const entry = parseSessionControlLogEntry(block) as ParsedConfirmationEntry;
		expect(entry.outcome).toBe('expired-or-stale');
	});
});

// ─── parseSessionControlLog ───────────────────────────────────────────────────

describe('parseSessionControlLog', () => {
	it('parses multiple entries from a full log', () => {
		const md =
			FRONTMATTER +
			makeClassificationBlock({ entryId: 'e1', zone: 'grey-zone' }) +
			makeConfirmationBlock({ entryId: 'e1', outcome: 'confirmed' }) +
			makeClassificationBlock({ zone: 'high-confidence' });
		const entries = parseSessionControlLog(md);
		expect(entries).toHaveLength(3);
		expect(entries[0]!.kind).toBe('classification');
		expect(entries[1]!.kind).toBe('confirmation');
		expect(entries[2]!.kind).toBe('classification');
	});

	it('returns empty array for log with only frontmatter', () => {
		expect(parseSessionControlLog(FRONTMATTER)).toHaveLength(0);
	});

	it('returns empty array for empty string', () => {
		expect(parseSessionControlLog('')).toHaveLength(0);
	});
});

// ─── analyzeSessionControlLog ─────────────────────────────────────────────────

describe('analyzeSessionControlLog', () => {
	it('counts classifications and confirmations', () => {
		const entries = parseSessionControlLog(
			FRONTMATTER +
				makeClassificationBlock({ zone: 'grey-zone', entryId: 'e1' }) +
				makeClassificationBlock({ zone: 'high-confidence' }) +
				makeConfirmationBlock({ entryId: 'e1', outcome: 'confirmed' }),
		);
		const stats = analyzeSessionControlLog(entries);
		expect(stats.total).toBe(3);
		expect(stats.classificationCount).toBe(2);
		expect(stats.confirmationCount).toBe(1);
	});

	it('computes per-zone counts', () => {
		const md =
			FRONTMATTER +
			makeClassificationBlock({ zone: 'grey-zone' }) +
			makeClassificationBlock({ zone: 'grey-zone' }) +
			makeClassificationBlock({ zone: 'high-confidence' }) +
			makeClassificationBlock({ zone: 'below-threshold' });
		const stats = analyzeSessionControlLog(parseSessionControlLog(md));
		expect(stats.zoneCounts['grey-zone']).toBe(2);
		expect(stats.zoneCounts['high-confidence']).toBe(1);
		expect(stats.zoneCounts['below-threshold']).toBe(1);
	});

	it('computes grey-zone confirmation rate from grey-zone-linked entries only', () => {
		const md =
			FRONTMATTER +
			makeClassificationBlock({ entryId: 'e1', zone: 'grey-zone' }) +
			makeClassificationBlock({ entryId: 'e2', zone: 'grey-zone' }) +
			makeClassificationBlock({ entryId: 'e3', zone: 'grey-zone' }) +
			makeConfirmationBlock({ outcome: 'confirmed', entryId: 'e1' }) +
			makeConfirmationBlock({ outcome: 'confirmed', entryId: 'e2' }) +
			makeConfirmationBlock({ outcome: 'declined', entryId: 'e3' });
		const stats = analyzeSessionControlLog(parseSessionControlLog(md));
		// 2 confirmed / (2 confirmed + 1 declined) = 2/3
		expect(stats.greyZoneConfirmationRate).toBeCloseTo(2 / 3);
	});

	it('excludes confirmations not linked to grey-zone classifications from rate', () => {
		const md =
			FRONTMATTER +
			// High-confidence classification (not grey-zone)
			makeClassificationBlock({ entryId: 'e_high', zone: 'high-confidence' }) +
			// Confirmation linked to a non-grey-zone classification
			makeConfirmationBlock({ outcome: 'confirmed', entryId: 'e_high' }) +
			// Orphan confirmation (no matching classification at all)
			makeConfirmationBlock({ outcome: 'confirmed', entryId: 'e_orphan' });
		const stats = analyzeSessionControlLog(parseSessionControlLog(md));
		// No grey-zone classifications → grey-zone entryId set empty → rate is NaN
		expect(Number.isNaN(stats.greyZoneConfirmationRate)).toBe(true);
	});

	it('returns NaN confirmation rate when no confirmations', () => {
		const stats = analyzeSessionControlLog([]);
		expect(Number.isNaN(stats.greyZoneConfirmationRate)).toBe(true);
	});

	it('returns top declined messages linked by entryId', () => {
		const md =
			FRONTMATTER +
			makeClassificationBlock({ entryId: 'e1', message: 'start new chat', zone: 'grey-zone' }) +
			makeClassificationBlock({ entryId: 'e2', message: 'fresh start please', zone: 'grey-zone' }) +
			makeConfirmationBlock({ entryId: 'e1', outcome: 'declined' }) +
			makeConfirmationBlock({ entryId: 'e2', outcome: 'declined' }) +
			makeConfirmationBlock({ entryId: 'e2', outcome: 'declined' }); // duplicate decline
		const stats = analyzeSessionControlLog(parseSessionControlLog(md));
		expect(stats.topDeclinedMessages).toHaveLength(2);
		// e2 declined twice should come first
		expect(stats.topDeclinedMessages[0]!.message).toContain('fresh start');
		expect(stats.topDeclinedMessages[0]!.count).toBe(2);
	});

	it('counts expired-or-stale outcomes', () => {
		const md =
			FRONTMATTER +
			makeConfirmationBlock({ outcome: 'expired-or-stale', entryId: 'e1' }) +
			makeConfirmationBlock({ outcome: 'confirmed', entryId: 'e2' });
		const stats = analyzeSessionControlLog(parseSessionControlLog(md));
		expect(stats.outcomeCounts['expired-or-stale']).toBe(1);
		expect(stats.outcomeCounts.confirmed).toBe(1);
	});
});

// ─── Round-trip with real SessionControlLogger ────────────────────────────────

describe('round-trip: SessionControlLogger → parseSessionControlLog', () => {
	let dir: string;
	let mockLogger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-rt-'));
		mockLogger = { warn: vi.fn(), info: vi.fn() };
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('writes classification + confirmation and parses them back identically', async () => {
		const logger = new SessionControlLogger(dir, mockLogger as any);

		const classEntry = {
			timestamp: new Date('2026-05-07T10:00:00Z'),
			userId: 'u1',
			messageText: 'start fresh',
			preFilter: 'unmatched' as const,
			llm: {
				intent: 'new_session',
				confidence: 0.55,
				reason: 'ambiguous signal',
				source: 'llm' as const,
			},
			zone: 'grey-zone' as const,
			entryId: 'abc123',
			latencyMs: 42,
		};

		const confEntry = {
			timestamp: new Date('2026-05-07T10:01:00Z'),
			userId: 'u1',
			entryId: 'abc123',
			outcome: 'confirmed' as const,
			elapsedMs: 3500,
		};

		await logger.logClassification(classEntry);
		await logger.logConfirmation(confEntry);

		const content = await readFile(join(dir, 'session-control-log.md'), 'utf-8');
		const entries = parseSessionControlLog(content);

		expect(entries).toHaveLength(2);

		const c = entries[0] as ParsedClassificationEntry;
		expect(c.kind).toBe('classification');
		expect(c.userId).toBe('u1');
		expect(c.zone).toBe('grey-zone');
		expect(c.entryId).toBe('abc123');
		expect(c.latencyMs).toBe(42);
		expect(c.preFilter).toBe('unmatched');

		const cf = entries[1] as ParsedConfirmationEntry;
		expect(cf.kind).toBe('confirmation');
		expect(cf.userId).toBe('u1');
		expect(cf.entryId).toBe('abc123');
		expect(cf.outcome).toBe('confirmed');
		expect(cf.elapsedMs).toBe(3500);
	});

	it('multiple entries written via real logger parse to correct count', async () => {
		const logger = new SessionControlLogger(dir, mockLogger as any);

		const base = {
			timestamp: new Date(),
			userId: 'u1',
			messageText: 'test',
			preFilter: 'unmatched' as const,
			llm: 'skipped' as const,
			zone: 'high-confidence' as const,
			latencyMs: 10,
		};

		await logger.logClassification({ ...base, zone: 'high-confidence' });
		await logger.logClassification({ ...base, zone: 'grey-zone', entryId: 'e1' });
		await logger.logClassification({ ...base, zone: 'below-threshold' });

		const content = await readFile(join(dir, 'session-control-log.md'), 'utf-8');
		const entries = parseSessionControlLog(content);
		expect(entries).toHaveLength(3);

		const stats = analyzeSessionControlLog(entries);
		expect(stats.zoneCounts['high-confidence']).toBe(1);
		expect(stats.zoneCounts['grey-zone']).toBe(1);
		expect(stats.zoneCounts['below-threshold']).toBe(1);
	});
});
