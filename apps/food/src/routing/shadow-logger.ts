import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RouteSource, RouteVerifierStatus } from '@pas/core/types';

export type ShadowResult =
    | { kind: 'ok'; action: string; confidence: number }
    | { kind: 'skipped-sample' }
    | { kind: 'skipped-no-caption' }
    | { kind: 'skipped-pending-flow'; flow: string }
    | { kind: 'skipped-cook-mode' }
    | { kind: 'skipped-number-select' }
    | { kind: 'legacy-skipped' }
    | { kind: 'parse-failed'; raw: string }
    | { kind: 'llm-error'; category: string };

export type ShadowVerdict =
    | 'agree' | 'disagree' | 'one-side-none' | 'both-none'
    | 'skipped' | 'error' | 'legacy-skipped' | 'shadow-dispatched';

export interface ShadowLogEntry {
    timestamp: Date;
    userId: string;
    messageText: string;
    messageKind: 'text' | 'photo';
    pendingFlow?: string;
    coreRoute?: {
        intent: string;
        confidence: number;
        source: RouteSource;
        verifierStatus: RouteVerifierStatus;
    };
    regexWinner: string;
    regexWinnerLabel: string;
    shadow: ShadowResult;
    verdict: ShadowVerdict;
    /**
     * True when shadow returned {kind:'ok', action≠'none'} but confidence was below
     * shadow_min_confidence and we fell through to the regex cascade. Purely telemetry.
     */
    shadowSuppressedByThreshold?: boolean;
}

const FRONTMATTER = `---
title: Food Shadow Classifier Log
type: system-log
tags: [pas/food-shadow-classifier]
---

`;

const MAX_MSG = 200;
const MAX_RAW = 100;

function fmtTs(d: Date): string {
    return d.toISOString().replace('T', ' ').substring(0, 19);
}

/** Code-point-safe truncation + JSON-safe escaping for embedding in markdown log lines. */
function safeForLog(raw: string, maxCodePoints: number): string {
    const oneLine = raw.replace(/[\r\n]+/g, ' ');
    // Array.from iterates by code point, not UTF-16 code unit, so emoji stay intact.
    const truncated = Array.from(oneLine).slice(0, maxCodePoints).join('');
    // JSON.stringify handles quotes, backslashes, and control characters.
    return JSON.stringify(truncated).slice(1, -1);  // strip outer quotes
}

export class FoodShadowLogger {
    private readonly logPath: string;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(dataDir: string) {
        this.logPath = join(dataDir, 'shadow-classifier-log.md');
    }

    log(entry: ShadowLogEntry): Promise<void> {
        // Serialize all writes through the promise chain so concurrent callers
        // cannot interleave their appendFile blocks.
        const next = this.writeChain.then(() => this.doLog(entry));
        // Keep the chain alive even if this call rejects, so later callers proceed.
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    private async doLog(entry: ShadowLogEntry): Promise<void> {
        await mkdir(dirname(this.logPath), { recursive: true });
        const block = this.formatEntry(entry);
        try {
            await writeFile(this.logPath, FRONTMATTER + block, { flag: 'wx', encoding: 'utf-8' });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
                await appendFile(this.logPath, block, 'utf-8');
            } else {
                throw err;
            }
        }
    }

    private formatEntry(e: ShadowLogEntry): string {
        const ts = fmtTs(e.timestamp);
        const text = safeForLog(e.messageText, MAX_MSG);
        const lines: string[] = [
            `## ${ts}`,
            '',
            `- **Message**: "${text}"`,
            `- **Kind**: ${e.messageKind}`,
            `- **User**: ${e.userId}`,
            `- **Pending flow**: ${e.pendingFlow ?? '(none)'}`,
            e.coreRoute
                ? `- **Core route**: food / ${e.coreRoute.intent} (confidence: ${e.coreRoute.confidence}, source: ${e.coreRoute.source}, verifier: ${e.coreRoute.verifierStatus})`
                : `- **Core route**: (absent)`,
            `- **Regex winner**: ${e.regexWinner} → "${e.regexWinnerLabel}"`,
            `- **Shadow**: ${this.fmtShadow(e.shadow)}`,
            `- **Verdict**: ${e.verdict}`,
        ];
        if (e.shadowSuppressedByThreshold) {
            lines.push(`- **ShadowSuppressedByThreshold**: true`);
        }
        lines.push('', '');
        return lines.join('\n');
    }

    private fmtShadow(s: ShadowResult): string {
        switch (s.kind) {
            case 'ok':                    return JSON.stringify({ action: s.action, confidence: s.confidence });
            case 'skipped-sample':        return 'skipped-sample';
            case 'skipped-no-caption':    return 'skipped-no-caption';
            case 'skipped-pending-flow':  return `skipped-pending-flow:${s.flow}`;
            case 'skipped-cook-mode':     return 'skipped-cook-mode';
            case 'skipped-number-select': return 'skipped-number-select';
            case 'legacy-skipped':        return 'legacy-skipped';
            case 'parse-failed':          return `parse-failed (raw: "${safeForLog(s.raw, MAX_RAW)}")`;
            case 'llm-error':             return `llm-error:${s.category}`;
        }
    }
}
