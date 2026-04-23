#!/usr/bin/env tsx
/**
 * analyze-shadow-log.ts
 *
 * Parses data/system/food/shadow-classifier-log.md and prints agreement
 * statistics for the Food shadow classifier.
 *
 * Usage:
 *   pnpm analyze-shadow-log [--log <path>]
 *
 * Exported for unit testing: parseShadowLogEntry, analyzeLog.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedEntry {
    /** "2026-04-24 12:00:00" from the ## header */
    timestamp: string;
    userId: string;
    pendingFlow: string;
    /** Raw key from "Regex winner: key → …" */
    regexWinner: string;
    /** Label from "Regex winner: … → "label"" */
    regexWinnerLabel: string;
    shadowKind: string;
    shadowAction?: string;
    shadowConfidence?: number;
    shadowErrorCategory?: string;
    verdict: string;
    suppressedByThreshold: boolean;
}

export interface LogStats {
    total: number;
    /** agree + disagree + one-side-none + both-none entries */
    judgmentTotal: number;
    verdicts: Record<string, number>;
    /** agree / judgmentTotal (0 when judgmentTotal=0) */
    agreementRate: number;
    perLabelAgreement: Array<{ label: string; agree: number; total: number; rate: number }>;
    topDisagreements: Array<{ regexLabel: string; shadowLabel: string; count: number }>;
    suppressedByThresholdCount: number;
}

// ─── Verdict sets ─────────────────────────────────────────────────────────────

const JUDGMENT_VERDICTS = new Set(['agree', 'disagree', 'one-side-none', 'both-none']);

// ─── Shadow field parser ──────────────────────────────────────────────────────

function parseShadowField(
    raw: string,
): Pick<ParsedEntry, 'shadowKind' | 'shadowAction' | 'shadowConfidence' | 'shadowErrorCategory'> {
    const t = raw.trim();

    // JSON form: {"action":"...","confidence":0.95}
    if (t.startsWith('{')) {
        try {
            const obj = JSON.parse(t) as { action?: string; confidence?: number };
            return {
                shadowKind: 'ok',
                shadowAction: typeof obj.action === 'string' ? obj.action : undefined,
                shadowConfidence: typeof obj.confidence === 'number' ? obj.confidence : undefined,
            };
        } catch {
            return { shadowKind: 'parse-failed' };
        }
    }

    // Sentinel strings — must be checked longest-first to avoid false prefix matches
    if (t.startsWith('skipped-pending-flow:')) return { shadowKind: 'skipped-pending-flow' };
    if (t.startsWith('parse-failed'))          return { shadowKind: 'parse-failed' };
    if (t === 'skipped-sample')                return { shadowKind: 'skipped-sample' };
    if (t === 'skipped-no-caption')            return { shadowKind: 'skipped-no-caption' };
    if (t === 'skipped-cook-mode')             return { shadowKind: 'skipped-cook-mode' };
    if (t === 'skipped-number-select')         return { shadowKind: 'skipped-number-select' };
    if (t === 'legacy-skipped')                return { shadowKind: 'legacy-skipped' };

    const llmErr = t.match(/^llm-error:(.+)$/);
    if (llmErr) return { shadowKind: 'llm-error', shadowErrorCategory: llmErr[1]!.trim() };

    return { shadowKind: 'unknown' };
}

// ─── Entry parser ─────────────────────────────────────────────────────────────

/**
 * Parses one "## …" block from the shadow log into a structured entry.
 * Returns null for empty or non-matching blocks.
 */
export function parseShadowLogEntry(block: string): ParsedEntry | null {
    if (!block.trim() || !block.startsWith('## ')) return null;

    const lines = block.split('\n');
    const timestamp = lines[0]!.slice(3).trim(); // strip "## "

    // Build key → value map from "- **Key**: value" lines
    const kv = new Map<string, string>();
    for (const line of lines.slice(1)) {
        const m = line.match(/^- \*\*([^*]+)\*\*:\s*(.*)$/);
        if (m) kv.set(m[1]!.trim(), m[2]!.trim());
    }

    // "Regex winner": "grocery_add → "user wants to add items to the grocery list""
    const rwLine = kv.get('Regex winner') ?? '';
    const rwMatch = rwLine.match(/^(.+?)\s+→\s+"(.*)"$/);
    const regexWinner = rwMatch ? rwMatch[1]!.trim() : rwLine.trim();
    const regexWinnerLabel = rwMatch ? rwMatch[2]! : '';

    const shadow = parseShadowField(kv.get('Shadow') ?? '');

    return {
        timestamp,
        userId: kv.get('User') ?? '',
        pendingFlow: kv.get('Pending flow') ?? '',
        regexWinner,
        regexWinnerLabel,
        ...shadow,
        verdict: kv.get('Verdict') ?? '',
        suppressedByThreshold: (kv.get('ShadowSuppressedByThreshold') ?? '').toLowerCase() === 'true',
    };
}

// ─── Log analyzer ─────────────────────────────────────────────────────────────

export function analyzeLog(markdown: string): LogStats {
    // Split on lines that start a new "## " header (lookahead keeps the header in each block)
    const blocks = markdown.split(/\n(?=## )/).filter((b) => b.startsWith('## '));
    const entries = blocks
        .map(parseShadowLogEntry)
        .filter((e): e is ParsedEntry => e !== null);

    const verdicts: Record<string, number> = {};
    const perLabel = new Map<string, { agree: number; total: number }>();
    const disagreementPairs = new Map<string, { regexLabel: string; shadowLabel: string; count: number }>();
    let judgmentTotal = 0;
    let agreeCount = 0;
    let suppressedByThresholdCount = 0;

    for (const e of entries) {
        verdicts[e.verdict] = (verdicts[e.verdict] ?? 0) + 1;
        if (e.suppressedByThreshold) suppressedByThresholdCount++;

        if (JUDGMENT_VERDICTS.has(e.verdict)) {
            judgmentTotal++;
            if (e.verdict === 'agree') agreeCount++;

            const labelKey = e.regexWinnerLabel || '(none)';
            const bucket = perLabel.get(labelKey) ?? { agree: 0, total: 0 };
            bucket.total++;
            if (e.verdict === 'agree') bucket.agree++;
            perLabel.set(labelKey, bucket);
        }

        if (e.verdict === 'disagree') {
            const key = `${e.regexWinnerLabel}|${e.shadowAction ?? ''}`;
            const bucket = disagreementPairs.get(key) ?? {
                regexLabel: e.regexWinnerLabel,
                shadowLabel: e.shadowAction ?? '',
                count: 0,
            };
            bucket.count++;
            disagreementPairs.set(key, bucket);
        }
    }

    const perLabelAgreement = Array.from(perLabel.entries())
        .map(([label, s]) => ({ label, agree: s.agree, total: s.total, rate: s.agree / s.total }))
        .sort((a, b) => a.rate - b.rate);

    const topDisagreements = Array.from(disagreementPairs.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

    return {
        total: entries.length,
        judgmentTotal,
        verdicts,
        agreementRate: judgmentTotal > 0 ? agreeCount / judgmentTotal : 0,
        perLabelAgreement,
        topDisagreements,
        suppressedByThresholdCount,
    };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            log: { type: 'string', default: 'data/system/food/shadow-classifier-log.md' },
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

    const stats = analyzeLog(md);

    console.log(`Shadow classifier log: ${logPath}`);
    console.log(`Total entries: ${stats.total}`);
    console.log(`Judgment entries (agree + disagree + one-side-none + both-none): ${stats.judgmentTotal}`);
    console.log(`Agreement rate: ${(stats.agreementRate * 100).toFixed(2)}%`);
    console.log(`Suppressed by threshold: ${stats.suppressedByThresholdCount}`);
    console.log('\nVerdict breakdown:');
    for (const [v, c] of Object.entries(stats.verdicts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${v.padEnd(22)}: ${c}`);
    }
    if (stats.perLabelAgreement.length > 0) {
        console.log('\nPer-label agreement (worst 10):');
        for (const row of stats.perLabelAgreement.slice(0, 10)) {
            console.log(`  ${(row.rate * 100).toFixed(1).padStart(5)}%  (${row.agree}/${row.total})  ${row.label}`);
        }
    }
    if (stats.topDisagreements.length > 0) {
        console.log('\nTop disagreements:');
        for (const d of stats.topDisagreements) {
            console.log(`  ×${d.count}  regex="${d.regexLabel}" → shadow="${d.shadowLabel}"`);
        }
    }
}

// Run when invoked as a script (not when imported in tests)
const isMain =
    import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('analyze-shadow-log.ts') ||
    process.argv[1]?.endsWith('analyze-shadow-log.js');

if (isMain) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
