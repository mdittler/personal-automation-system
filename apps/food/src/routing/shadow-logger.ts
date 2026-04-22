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
    | 'skipped' | 'error' | 'legacy-skipped';

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

function sanitizeMessage(raw: string): string {
    // Collapse CR/LF (and any combination) to a single space, then truncate.
    const oneLine = raw.replace(/[\r\n]+/g, ' ').substring(0, MAX_MSG);
    // JSON.stringify safely escapes quotes, backslashes, and remaining control chars.
    // Remove the outer quotes so we can emit our own surrounding quotes.
    return JSON.stringify(oneLine).slice(1, -1);
}

export class FoodShadowLogger {
    private readonly logPath: string;

    constructor(dataDir: string) {
        this.logPath = join(dataDir, 'shadow-classifier-log.md');
    }

    async log(entry: ShadowLogEntry): Promise<void> {
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
        const text = sanitizeMessage(e.messageText);
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
            '',
            '',
        ];
        return lines.join('\n');
    }

    private fmtShadow(s: ShadowResult): string {
        switch (s.kind) {
            case 'ok':                    return `{"action": "${s.action}", "confidence": ${s.confidence}}`;
            case 'skipped-sample':        return 'skipped-sample';
            case 'skipped-no-caption':    return 'skipped-no-caption';
            case 'skipped-pending-flow':  return `skipped-pending-flow:${s.flow}`;
            case 'skipped-cook-mode':     return 'skipped-cook-mode';
            case 'skipped-number-select': return 'skipped-number-select';
            case 'legacy-skipped':        return 'legacy-skipped';
            case 'parse-failed':          return `parse-failed (raw: ${JSON.stringify(s.raw.substring(0, MAX_RAW))})`;
            case 'llm-error':             return `llm-error:${s.category}`;
        }
    }
}
