import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FoodShadowLogger, type ShadowLogEntry } from '../shadow-logger.js';

function sampleEntry(over: Partial<ShadowLogEntry> = {}): ShadowLogEntry {
    return {
        timestamp: new Date('2026-04-22T18:31:14.000Z'),
        userId: 'user-42',
        messageText: 'add milk to grocery list',
        messageKind: 'text',
        pendingFlow: undefined,
        coreRoute: {
            intent: 'user wants to add items to the grocery list',
            confidence: 0.88,
            source: 'intent',
            verifierStatus: 'agreed',
        },
        regexWinner: 'grocery_add',
        regexWinnerLabel: 'user wants to add items to the grocery list',
        shadow: { kind: 'ok', action: 'user wants to add items to the grocery list', confidence: 0.94 },
        verdict: 'agree',
        ...over,
    };
}

describe('FoodShadowLogger', () => {
    let dir: string;
    let logger: FoodShadowLogger;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'food-shadow-'));
        logger = new FoodShadowLogger(dir);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('creates file with frontmatter on first write', async () => {
        await logger.log(sampleEntry());
        const path = join(dir, 'shadow-classifier-log.md');
        expect(existsSync(path)).toBe(true);
        const contents = readFileSync(path, 'utf8');
        expect(contents.startsWith('---\ntitle: Food Shadow Classifier Log\n')).toBe(true);
        expect(contents).toContain('tags: [pas/food-shadow-classifier]');
        expect(contents).toContain('## 2026-04-22 18:31:14');
    });

    it('appends without re-emitting frontmatter on second write', async () => {
        await logger.log(sampleEntry());
        await logger.log(sampleEntry({ userId: 'user-55', messageText: 'hello' }));
        const contents = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        const frontmatterCount = (contents.match(/^---\ntitle:/gm) ?? []).length;
        expect(frontmatterCount).toBe(1);
        expect(contents).toContain('user-42');
        expect(contents).toContain('user-55');
    });

    it('formats every field correctly for a text "ok" entry', async () => {
        await logger.log(sampleEntry());
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        expect(c).toMatch(/- \*\*Message\*\*: "add milk to grocery list"/);
        expect(c).toMatch(/- \*\*Kind\*\*: text/);
        expect(c).toMatch(/- \*\*User\*\*: user-42/);
        expect(c).toMatch(/- \*\*Pending flow\*\*: \(none\)/);
        expect(c).toMatch(/- \*\*Core route\*\*: food \/ user wants to add items to the grocery list \(confidence: 0\.88, source: intent, verifier: agreed\)/);
        expect(c).toMatch(/- \*\*Regex winner\*\*: grocery_add → "user wants to add items to the grocery list"/);
        expect(c).toMatch(/- \*\*Shadow\*\*: \{"action": "user wants to add items to the grocery list", "confidence": 0\.94\}/);
        expect(c).toMatch(/- \*\*Verdict\*\*: agree/);
    });

    it('renders messageKind=photo distinctly', async () => {
        await logger.log(sampleEntry({ messageKind: 'photo', messageText: 'look at this receipt' }));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        expect(c).toMatch(/- \*\*Kind\*\*: photo/);
    });

    it('renders "(absent)" when coreRoute is undefined', async () => {
        await logger.log(sampleEntry({ coreRoute: undefined }));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        expect(c).toMatch(/- \*\*Core route\*\*: \(absent\)/);
    });

    it('renders pendingFlow when set', async () => {
        await logger.log(sampleEntry({ pendingFlow: 'targets_flow' }));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        expect(c).toMatch(/- \*\*Pending flow\*\*: targets_flow/);
    });

    it('renders all ShadowResult kinds correctly', async () => {
        await logger.log(sampleEntry({ shadow: { kind: 'skipped-sample' }, verdict: 'skipped' }));
        await logger.log(sampleEntry({ shadow: { kind: 'skipped-no-caption' }, verdict: 'skipped' }));
        await logger.log(sampleEntry({ shadow: { kind: 'skipped-pending-flow', flow: 'cook_recipe' }, verdict: 'skipped' }));
        await logger.log(sampleEntry({ shadow: { kind: 'skipped-cook-mode' }, verdict: 'skipped' }));
        await logger.log(sampleEntry({ shadow: { kind: 'skipped-number-select' }, verdict: 'skipped' }));
        await logger.log(sampleEntry({ shadow: { kind: 'legacy-skipped' }, verdict: 'legacy-skipped' }));
        await logger.log(sampleEntry({ shadow: { kind: 'parse-failed', raw: 'not json' }, verdict: 'error' }));
        await logger.log(sampleEntry({ shadow: { kind: 'llm-error', category: 'cost-cap' }, verdict: 'skipped' }));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        expect(c).toContain('- **Shadow**: skipped-sample');
        expect(c).toContain('- **Shadow**: skipped-no-caption');
        expect(c).toContain('- **Shadow**: skipped-pending-flow:cook_recipe');
        expect(c).toContain('- **Shadow**: skipped-cook-mode');
        expect(c).toContain('- **Shadow**: skipped-number-select');
        expect(c).toContain('- **Shadow**: legacy-skipped');
        expect(c).toContain('- **Shadow**: parse-failed (raw: "not json")');
        expect(c).toContain('- **Shadow**: llm-error:cost-cap');
    });

    it('truncates long messageText to 200 chars', async () => {
        const long = 'a'.repeat(500);
        await logger.log(sampleEntry({ messageText: long }));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        expect(c).toContain(`"${'a'.repeat(200)}"`);
        expect(c).not.toContain(`"${'a'.repeat(201)}"`);
    });

    it('truncates parse-failed raw to 100 chars', async () => {
        const raw = 'x'.repeat(500);
        await logger.log(sampleEntry({ shadow: { kind: 'parse-failed', raw }, verdict: 'error' }));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        expect(c).toContain(`"${'x'.repeat(100)}"`);
        expect(c).not.toContain(`"${'x'.repeat(101)}"`);
    });

    // Codex P2.3: logger safety with raw user text
    it('normalizes multiline text to single line (CR/LF collapsed)', async () => {
        await logger.log(sampleEntry({ messageText: 'line 1\nline 2\r\nline 3' }));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        expect(c).toContain('- **Message**: "line 1 line 2 line 3"');
        // Should not have bare newlines inside the message field
        const msgLine = c.split('\n').find((l) => l.startsWith('- **Message**:'));
        expect(msgLine).toBeDefined();
    });

    it('escapes embedded double quotes safely (JSON-encode)', async () => {
        await logger.log(sampleEntry({ messageText: 'she said "hello" today' }));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        // The field should use \" not raw quotes that could break markdown parsing
        expect(c).toContain('- **Message**: "she said \\"hello\\" today"');
    });

    it('handles backticks without breaking markdown structure', async () => {
        await logger.log(sampleEntry({ messageText: 'use `code` here' }));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        // Frontmatter and section headers must still be intact
        expect(c).toContain('---\ntitle: Food Shadow Classifier Log');
        expect(c).toContain('## 2026-04-22 18:31:14');
        // The message text must appear in some encoded form
        expect(c).toContain('use');
        expect(c).toContain('code');
    });

    it('concurrent log() calls from different users all appear (no data loss)', async () => {
        const N = 20;
        await Promise.all(
            Array.from({ length: N }, (_, i) =>
                logger.log(sampleEntry({ userId: `user-${i}`, messageText: `msg ${i}` })),
        ));
        const c = readFileSync(join(dir, 'shadow-classifier-log.md'), 'utf8');
        for (let i = 0; i < N; i++) {
            expect(c, `missing user-${i}`).toContain(`user-${i}`);
            expect(c, `missing msg ${i}`).toContain(`msg ${i}`);
        }
    });

    it('creates parent directory if missing', async () => {
        const nested = join(dir, 'a', 'b', 'c');
        const l2 = new FoodShadowLogger(nested);
        await l2.log(sampleEntry());
        expect(existsSync(join(nested, 'shadow-classifier-log.md'))).toBe(true);
    });

    it('propagates write errors to caller (caller controls catch policy)', async () => {
        // Write the file as a directory to provoke a write error
        const badDir = join(dir, 'shadow-classifier-log.md');
        mkdtempSync(badDir);  // create as directory, not file
        await expect(logger.log(sampleEntry())).rejects.toThrow();
    });
});
