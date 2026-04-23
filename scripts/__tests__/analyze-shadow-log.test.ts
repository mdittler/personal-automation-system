/**
 * Unit tests for analyze-shadow-log.ts
 *
 * Uses inline synthetic log content constructed to match the exact format
 * produced by FoodShadowLogger.formatEntry (verified against shadow-logger.ts).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { parseShadowLogEntry, analyzeLog } from '../analyze-shadow-log.js';
import { FoodShadowLogger } from '../../apps/food/src/routing/shadow-logger.js';
import type { ShadowLogEntry } from '../../apps/food/src/routing/shadow-logger.js';

// ─── Synthetic log fixture ────────────────────────────────────────────────────

// Matches FRONTMATTER constant in shadow-logger.ts exactly
const FRONTMATTER = `---
title: Food Shadow Classifier Log
type: system-log
tags: [pas/food-shadow-classifier]
---

`;

// Six representative entries covering every key verdict type
const synthetic = FRONTMATTER + [
    // 1) agree — regex and shadow both pick grocery_add
    `## 2026-04-24 12:00:00`,
    ``,
    `- **Message**: "add milk"`,
    `- **Kind**: text`,
    `- **User**: u1`,
    `- **Pending flow**: (none)`,
    `- **Core route**: (absent)`,
    `- **Regex winner**: grocery_add → "user wants to add items to the grocery list"`,
    `- **Shadow**: {"action":"user wants to add items to the grocery list","confidence":0.95}`,
    `- **Verdict**: agree`,
    ``,
    ``,
    // 2) one-side-none — regex missed, shadow found a label
    `## 2026-04-24 12:01:00`,
    ``,
    `- **Message**: "whats good"`,
    `- **Kind**: text`,
    `- **User**: u1`,
    `- **Pending flow**: (none)`,
    `- **Core route**: (absent)`,
    `- **Regex winner**: help_fallthrough → "none"`,
    `- **Shadow**: {"action":"user has a food-related question","confidence":0.8}`,
    `- **Verdict**: one-side-none`,
    ``,
    ``,
    // 3) disagree — regex says grocery_add, shadow says food question
    `## 2026-04-24 12:02:00`,
    ``,
    `- **Message**: "add bread"`,
    `- **Kind**: text`,
    `- **User**: u1`,
    `- **Pending flow**: (none)`,
    `- **Core route**: (absent)`,
    `- **Regex winner**: grocery_add → "user wants to add items to the grocery list"`,
    `- **Shadow**: {"action":"user has a food-related question","confidence":0.9}`,
    `- **Verdict**: disagree`,
    ``,
    ``,
    // 4) skipped — shadow_sample_rate=0 caused skipped-sample
    `## 2026-04-24 12:03:00`,
    ``,
    `- **Message**: "hi"`,
    `- **Kind**: text`,
    `- **User**: u1`,
    `- **Pending flow**: (none)`,
    `- **Core route**: (absent)`,
    `- **Regex winner**: help_fallthrough → "none"`,
    `- **Shadow**: skipped-sample`,
    `- **Verdict**: skipped`,
    ``,
    ``,
    // 5) shadow-dispatched (Chunk D) — must NOT count toward judgment total
    `## 2026-04-24 12:04:00`,
    ``,
    `- **Message**: "get eggs"`,
    `- **Kind**: text`,
    `- **User**: u1`,
    `- **Pending flow**: (none)`,
    `- **Core route**: (absent)`,
    `- **Regex winner**: (shadow-dispatched) → "none"`,
    `- **Shadow**: {"action":"user wants to add items to the grocery list","confidence":0.95}`,
    `- **Verdict**: shadow-dispatched`,
    ``,
    ``,
    // 6) agree + suppressedByThreshold (shadow fell through to regex but agreed)
    `## 2026-04-24 12:05:00`,
    ``,
    `- **Message**: "add juice"`,
    `- **Kind**: text`,
    `- **User**: u1`,
    `- **Pending flow**: (none)`,
    `- **Core route**: (absent)`,
    `- **Regex winner**: grocery_add → "user wants to add items to the grocery list"`,
    `- **Shadow**: {"action":"user wants to add items to the grocery list","confidence":0.5}`,
    `- **Verdict**: agree`,
    `- **ShadowSuppressedByThreshold**: true`,
    ``,
    ``,
].join('\n');

// ─── parseShadowLogEntry ──────────────────────────────────────────────────────

describe('parseShadowLogEntry', () => {
    it('returns null for empty string', () => {
        expect(parseShadowLogEntry('')).toBeNull();
    });

    it('returns null for a block that does not start with ##', () => {
        expect(parseShadowLogEntry('- **Verdict**: agree')).toBeNull();
    });

    it('parses an agree entry with JSON Shadow field', () => {
        const blocks = synthetic.split('\n## ');
        const entry = parseShadowLogEntry('## ' + blocks[1]!);
        expect(entry).not.toBeNull();
        expect(entry!.timestamp).toBe('2026-04-24 12:00:00');
        expect(entry!.userId).toBe('u1');
        expect(entry!.pendingFlow).toBe('(none)');
        expect(entry!.regexWinner).toBe('grocery_add');
        expect(entry!.regexWinnerLabel).toBe('user wants to add items to the grocery list');
        expect(entry!.shadowKind).toBe('ok');
        expect(entry!.shadowAction).toBe('user wants to add items to the grocery list');
        expect(entry!.shadowConfidence).toBe(0.95);
        expect(entry!.verdict).toBe('agree');
        expect(entry!.suppressedByThreshold).toBe(false);
    });

    it('parses a sentinel Shadow field (skipped-sample)', () => {
        const blocks = synthetic.split('\n## ');
        const entry = parseShadowLogEntry('## ' + blocks[4]!); // skipped-sample entry
        expect(entry).not.toBeNull();
        expect(entry!.shadowKind).toBe('skipped-sample');
        expect(entry!.shadowAction).toBeUndefined();
        expect(entry!.shadowConfidence).toBeUndefined();
        expect(entry!.verdict).toBe('skipped');
    });

    it('parses shadow-dispatched verdict and (shadow-dispatched) sentinel regex winner', () => {
        const blocks = synthetic.split('\n## ');
        const entry = parseShadowLogEntry('## ' + blocks[5]!); // shadow-dispatched entry
        expect(entry).not.toBeNull();
        expect(entry!.verdict).toBe('shadow-dispatched');
        expect(entry!.regexWinner).toBe('(shadow-dispatched)');
    });

    it('parses ShadowSuppressedByThreshold=true when present', () => {
        const blocks = synthetic.split('\n## ');
        const entry = parseShadowLogEntry('## ' + blocks[6]!); // suppressed entry
        expect(entry).not.toBeNull();
        expect(entry!.suppressedByThreshold).toBe(true);
        expect(entry!.verdict).toBe('agree');
    });

    it('parses llm-error:<category> Shadow sentinel', () => {
        const block = [
            `## 2026-04-24 12:10:00`,
            ``,
            `- **Message**: "x"`,
            `- **Kind**: text`,
            `- **User**: u1`,
            `- **Pending flow**: (none)`,
            `- **Core route**: (absent)`,
            `- **Regex winner**: help_fallthrough → "none"`,
            `- **Shadow**: llm-error:rate-limit`,
            `- **Verdict**: error`,
        ].join('\n');
        const e = parseShadowLogEntry(block);
        expect(e).not.toBeNull();
        expect(e!.shadowKind).toBe('llm-error');
        expect(e!.shadowErrorCategory).toBe('rate-limit');
    });

    it('parses parse-failed Shadow sentinel', () => {
        const block = [
            `## 2026-04-24 12:11:00`,
            ``,
            `- **Message**: "x"`,
            `- **Kind**: text`,
            `- **User**: u1`,
            `- **Pending flow**: (none)`,
            `- **Core route**: (absent)`,
            `- **Regex winner**: help_fallthrough → "none"`,
            `- **Shadow**: parse-failed (raw: "bad json")`,
            `- **Verdict**: error`,
        ].join('\n');
        const e = parseShadowLogEntry(block);
        expect(e).not.toBeNull();
        expect(e!.shadowKind).toBe('parse-failed');
    });

    it('parses skipped-pending-flow:<flow> sentinel', () => {
        const block = [
            `## 2026-04-24 12:12:00`,
            ``,
            `- **Message**: "next"`,
            `- **Kind**: text`,
            `- **User**: u1`,
            `- **Pending flow**: leftover-add`,
            `- **Core route**: (absent)`,
            `- **Regex winner**: pending_flow_consumed → "none"`,
            `- **Shadow**: skipped-pending-flow:leftover-add`,
            `- **Verdict**: skipped`,
        ].join('\n');
        const e = parseShadowLogEntry(block);
        expect(e).not.toBeNull();
        expect(e!.shadowKind).toBe('skipped-pending-flow');
        expect(e!.pendingFlow).toBe('leftover-add');
    });

    it('parses core route field when present', () => {
        const block = [
            `## 2026-04-24 12:13:00`,
            ``,
            `- **Message**: "what did you plan for tonight"`,
            `- **Kind**: text`,
            `- **User**: u1`,
            `- **Pending flow**: (none)`,
            `- **Core route**: food / user wants to know what's for dinner (confidence: 0.95, source: intent, verifier: agreed)`,
            `- **Regex winner**: (route-dispatched) → "none"`,
            `- **Shadow**: legacy-skipped`,
            `- **Verdict**: legacy-skipped`,
        ].join('\n');
        const e = parseShadowLogEntry(block);
        expect(e).not.toBeNull();
        expect(e!.shadowKind).toBe('legacy-skipped');
        expect(e!.verdict).toBe('legacy-skipped');
        expect(e!.regexWinner).toBe('(route-dispatched)');
    });
});

// ─── analyzeLog ───────────────────────────────────────────────────────────────

describe('analyzeLog', () => {
    it('computes correct totals from synthetic log', () => {
        const stats = analyzeLog(synthetic);
        expect(stats.total).toBe(6);
    });

    it('excludes shadow-dispatched and skipped from judgment total', () => {
        const stats = analyzeLog(synthetic);
        // Judgment set = {agree, disagree, one-side-none, both-none}
        // Entries: agree(×2), one-side-none(×1), disagree(×1), skipped(×1), shadow-dispatched(×1)
        // shadow-dispatched and skipped are NOT in the judgment set
        expect(stats.judgmentTotal).toBe(4);
    });

    it('counts verdict distribution correctly', () => {
        const stats = analyzeLog(synthetic);
        expect(stats.verdicts.agree).toBe(2);
        expect(stats.verdicts.disagree).toBe(1);
        expect(stats.verdicts['one-side-none']).toBe(1);
        expect(stats.verdicts.skipped).toBe(1);
        expect(stats.verdicts['shadow-dispatched']).toBe(1);
        expect(stats.verdicts.error).toBeUndefined();
    });

    it('computes agreement rate over judgment entries only', () => {
        const stats = analyzeLog(synthetic);
        // 2 agree out of 4 judgment entries
        expect(stats.agreementRate).toBeCloseTo(2 / 4, 4);
    });

    it('counts suppressedByThreshold entries', () => {
        const stats = analyzeLog(synthetic);
        expect(stats.suppressedByThresholdCount).toBe(1);
    });

    it('groups disagreements by regex/shadow label pair', () => {
        const stats = analyzeLog(synthetic);
        expect(stats.topDisagreements).toContainEqual(expect.objectContaining({
            regexLabel: 'user wants to add items to the grocery list',
            shadowLabel: 'user has a food-related question',
            count: 1,
        }));
    });

    it('tolerates an empty log body (just frontmatter)', () => {
        const stats = analyzeLog(FRONTMATTER);
        expect(stats.total).toBe(0);
        expect(stats.judgmentTotal).toBe(0);
        expect(stats.agreementRate).toBe(0);
    });

    it('tolerates an empty string', () => {
        const stats = analyzeLog('');
        expect(stats.total).toBe(0);
        expect(stats.agreementRate).toBe(0);
    });

    it('computes per-label agreement correctly', () => {
        const stats = analyzeLog(synthetic);
        // "user wants to add items to the grocery list" appears 3 times in judgment:
        //   entry 1 (agree), entry 3 (disagree), entry 6 (agree+suppressed)
        // But entry 2 (one-side-none) has regexWinnerLabel="none" → maps to "(none)"
        const groceryRow = stats.perLabelAgreement.find(
            (r) => r.label === 'user wants to add items to the grocery list',
        );
        expect(groceryRow).toBeDefined();
        expect(groceryRow!.total).toBe(3); // entries 1, 3, 6
        expect(groceryRow!.agree).toBe(2); // entries 1, 6
        expect(groceryRow!.rate).toBeCloseTo(2 / 3, 4);
    });

    it('handles a log with only skipped/shadow-dispatched entries (0 judgment entries)', () => {
        const log = FRONTMATTER + [
            `## 2026-04-24 12:00:00`,
            ``,
            `- **Message**: "hi"`,
            `- **Kind**: text`,
            `- **User**: u1`,
            `- **Pending flow**: (none)`,
            `- **Core route**: (absent)`,
            `- **Regex winner**: help_fallthrough → "none"`,
            `- **Shadow**: skipped-sample`,
            `- **Verdict**: skipped`,
            ``,
            ``,
        ].join('\n');
        const stats = analyzeLog(log);
        expect(stats.total).toBe(1);
        expect(stats.judgmentTotal).toBe(0);
        expect(stats.agreementRate).toBe(0);
    });

    it('handles both-none verdict correctly (counts as judgment, not agree)', () => {
        const log = FRONTMATTER + [
            `## 2026-04-24 12:00:00`,
            ``,
            `- **Message**: "xyz"`,
            `- **Kind**: text`,
            `- **User**: u1`,
            `- **Pending flow**: (none)`,
            `- **Core route**: (absent)`,
            `- **Regex winner**: help_fallthrough → "none"`,
            `- **Shadow**: {"action":"none","confidence":0.5}`,
            `- **Verdict**: both-none`,
            ``,
            ``,
        ].join('\n');
        const stats = analyzeLog(log);
        expect(stats.total).toBe(1);
        expect(stats.judgmentTotal).toBe(1);
        expect(stats.verdicts['both-none']).toBe(1);
        expect(stats.agreementRate).toBe(0); // both-none ≠ agree
    });
});

// ─── FoodShadowLogger ↔ parseShadowLogEntry round-trip ───────────────────────

describe('FoodShadowLogger ↔ parseShadowLogEntry round-trip', () => {
    let tmpDir: string;
    let logger: FoodShadowLogger;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'shadow-log-rt-'));
        logger = new FoodShadowLogger(tmpDir);
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    async function parseWrittenEntries(dir: string) {
        const logPath = join(dir, 'shadow-classifier-log.md');
        const md = await readFile(logPath, 'utf-8');
        const blocks = md.split(/\n(?=## )/).filter((b) => b.startsWith('## '));
        return blocks.map((b) => parseShadowLogEntry(b)).filter((e): e is NonNullable<typeof e> => e !== null);
    }

    it('round-trips a baseline agree entry preserving every field', async () => {
        const ts = new Date('2026-04-24T12:00:00.000Z');
        const entry: ShadowLogEntry = {
            timestamp: ts,
            userId: 'rt-user-1',
            messageText: 'add milk',
            messageKind: 'text',
            regexWinner: 'grocery_add',
            regexWinnerLabel: 'user wants to add items to the grocery list',
            shadow: { kind: 'ok', action: 'user wants to add items to the grocery list', confidence: 0.95 },
            verdict: 'agree',
        };

        await logger.log(entry);

        const entries = await parseWrittenEntries(tmpDir);
        expect(entries).toHaveLength(1);
        const p = entries[0]!;

        expect(p.timestamp).toBe('2026-04-24 12:00:00');
        expect(p.userId).toBe('rt-user-1');
        expect(p.pendingFlow).toBe('(none)');
        expect(p.regexWinner).toBe('grocery_add');
        expect(p.regexWinnerLabel).toBe('user wants to add items to the grocery list');
        expect(p.shadowKind).toBe('ok');
        expect(p.shadowAction).toBe('user wants to add items to the grocery list');
        expect(p.shadowConfidence).toBe(0.95);
        expect(p.verdict).toBe('agree');
        expect(p.suppressedByThreshold).toBe(false);
    });

    it('round-trips an entry with shadowSuppressedByThreshold=true preserving the flag', async () => {
        const ts = new Date('2026-04-24T12:05:00.000Z');
        const entry: ShadowLogEntry = {
            timestamp: ts,
            userId: 'rt-user-2',
            messageText: 'add juice',
            messageKind: 'text',
            regexWinner: 'grocery_add',
            regexWinnerLabel: 'user wants to add items to the grocery list',
            shadow: { kind: 'ok', action: 'user wants to add items to the grocery list', confidence: 0.5 },
            verdict: 'agree',
            shadowSuppressedByThreshold: true,
        };

        await logger.log(entry);

        const entries = await parseWrittenEntries(tmpDir);
        expect(entries).toHaveLength(1);
        const p = entries[0]!;

        expect(p.timestamp).toBe('2026-04-24 12:05:00');
        expect(p.userId).toBe('rt-user-2');
        expect(p.regexWinner).toBe('grocery_add');
        expect(p.regexWinnerLabel).toBe('user wants to add items to the grocery list');
        expect(p.shadowKind).toBe('ok');
        expect(p.shadowAction).toBe('user wants to add items to the grocery list');
        expect(p.shadowConfidence).toBe(0.5);
        expect(p.verdict).toBe('agree');
        expect(p.suppressedByThreshold).toBe(true);
    });
});
