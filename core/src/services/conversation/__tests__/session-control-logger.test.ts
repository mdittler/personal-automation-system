/**
 * Tests for SessionControlLogger.
 *
 * Covers: happy / edge / error / security / concurrency / state / config categories.
 * Round-trip with parser is marked todo until analyze-session-control-log.ts lands (Task 2.3).
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	SessionControlLogger,
	type SessionControlClassificationEntry,
	type SessionControlConfirmationEntry,
} from '../session-control-logger.js';

let dir: string;
let mockLogger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'sc-log-'));
	mockLogger = { warn: vi.fn(), info: vi.fn() };
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function makeClassification(
	overrides: Partial<SessionControlClassificationEntry> = {},
): SessionControlClassificationEntry {
	return {
		timestamp: new Date('2026-05-07T12:00:00Z'),
		userId: 'u1',
		messageText: 'can we start fresh',
		preFilter: 'matched',
		llm: { intent: 'new_session', confidence: 0.6, reason: 'explicit new session request', source: 'llm' },
		zone: 'grey-zone',
		entryId: 'abc123',
		latencyMs: 42,
		...overrides,
	};
}

function makeConfirmation(
	overrides: Partial<SessionControlConfirmationEntry> = {},
): SessionControlConfirmationEntry {
	return {
		timestamp: new Date('2026-05-07T12:00:05Z'),
		userId: 'u1',
		entryId: 'abc123',
		outcome: 'confirmed',
		elapsedMs: 5000,
		...overrides,
	};
}

async function readLog(logDir: string): Promise<string> {
	return readFile(join(logDir, 'session-control-log.md'), 'utf-8');
}

// ─── logClassification ────────────────────────────────────────────────────────

describe('SessionControlLogger.logClassification', () => {
	it('writes a markdown entry with YAML frontmatter on first call', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification());
		const content = await readLog(dir);
		expect(content).toMatch(/^---\ntitle: Session Control Classifier Log/);
		expect(content).toContain('type: system-log');
		expect(content).toContain('tags: [pas/session-control-classifier]');
	});

	it('writes an ## timestamp heading', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification());
		const content = await readLog(dir);
		expect(content).toContain('## 2026-05-07 12:00:00');
	});

	it('includes all required fields in classification block', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification());
		const content = await readLog(dir);
		expect(content).toContain('- **Kind**: classification');
		expect(content).toContain('- **User**: u1');
		expect(content).toContain('- **Message**:');
		expect(content).toContain('- **Pre-filter**: matched');
		expect(content).toContain('- **LLM**:');
		expect(content).toContain('- **Zone**: grey-zone');
		expect(content).toContain('- **Entry ID**: abc123');
		expect(content).toContain('- **Latency**: 42ms');
	});

	it('omits Entry ID line when entryId is undefined', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification({ entryId: undefined, zone: 'high-confidence' }));
		const content = await readLog(dir);
		expect(content).not.toContain('Entry ID');
	});

	it('writes "skipped" as the LLM value when llm field is "skipped"', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification({ llm: 'skipped', zone: 'high-confidence' }));
		const content = await readLog(dir);
		expect(content).toContain('- **LLM**: skipped');
	});

	it('appends to existing file without rewriting frontmatter on second call', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification({ timestamp: new Date('2026-05-07T12:00:00Z') }));
		await logger.logClassification(makeClassification({ timestamp: new Date('2026-05-07T12:00:01Z') }));
		const content = await readLog(dir);
		const frontmatterCount = (content.match(/^title: Session Control Classifier Log/m) ?? []).length;
		expect(frontmatterCount).toBe(1);
		// Two ## headings
		expect((content.match(/^## /gm) ?? [])).toHaveLength(2);
	});

	it('serializes concurrent writes (10 simultaneous calls → 10 distinct entries)', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				logger.logClassification(
					makeClassification({ entryId: `entry-${i}`, userId: `u${i}` }),
				),
			),
		);
		const content = await readLog(dir);
		const headings = content.match(/^## /gm) ?? [];
		expect(headings).toHaveLength(10);
		// Verify no frontmatter duplication from concurrent writes
		const frontmatterCount = (content.match(/^title: Session Control Classifier Log/m) ?? []).length;
		expect(frontmatterCount).toBe(1);
	});

	it('creates parent directory when it does not exist', async () => {
		const nestedDir = join(dir, 'a', 'b', 'c');
		const logger = new SessionControlLogger(nestedDir, mockLogger);
		await logger.logClassification(makeClassification());
		const content = await readFile(join(nestedDir, 'session-control-log.md'), 'utf-8');
		expect(content).toContain('- **Kind**: classification');
	});

	it('truncates messageText to 200 code points', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		const longMsg = 'a'.repeat(300);
		await logger.logClassification(makeClassification({ messageText: longMsg }));
		const content = await readLog(dir);
		// The written message must not exceed 200 chars (plus surrounding quotes)
		const match = content.match(/- \*\*Message\*\*: "([^"]+)"/);
		expect(match).toBeTruthy();
		expect(Array.from(match![1]).length).toBeLessThanOrEqual(200);
	});

	it('preserves emoji code points (Array.from code-point iteration)', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		// 3 emoji, each is 2 UTF-16 units → 3 code points
		const emojiMsg = '🎉🎊🎈 test';
		await logger.logClassification(makeClassification({ messageText: emojiMsg }));
		const content = await readLog(dir);
		// emoji should survive (JSON-serialized as unicode escapes or literal)
		expect(content).toContain('🎉');
	});

	it('collapses newlines to a single space', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification({ messageText: 'line1\nline2\r\nline3' }));
		const content = await readLog(dir);
		expect(content).not.toMatch(/line1\n/);
		expect(content).toContain('line1 line2 line3');
	});
});

// ─── Security: safeForLog stripping ──────────────────────────────────────────

describe('SessionControlLogger — security (safeForLog)', () => {
	it('strips </script> closing tags (opening tag may remain — closing tag is the XSS vector)', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		const hostile = '</script><script>alert(1)</script>';
		await logger.logClassification(makeClassification({ messageText: hostile }));
		const content = await readLog(dir);
		expect(content).not.toContain('</script>');
		expect(content).toContain('[/script]');
	});

	it('strips </style> tags (case-insensitive)', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification({ messageText: '</STYLE>hack</style>' }));
		const content = await readLog(dir);
		expect(content).not.toContain('</style>');
		expect(content).not.toContain('</STYLE>');
		expect(content).toContain('[/style]');
	});

	it('replaces backticks to prevent markdown code-fence injection', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification({ messageText: '`cmd injection`' }));
		const content = await readLog(dir);
		expect(content).not.toMatch(/`/);
	});

	it('strips bidi control characters (U+202E right-to-left override)', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		// U+202E = RIGHT-TO-LEFT OVERRIDE (visible as ‮ in some editors)
		const withBidi = 'hello‮world';
		await logger.logClassification(makeClassification({ messageText: withBidi }));
		const content = await readLog(dir);
		expect(content).not.toContain('‮');
		expect(content).toContain('[bidi]');
	});

	it('strips U+2066 (LEFT-TO-RIGHT ISOLATE) bidi control', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		const withBidi = 'test⁦inject⁩end';
		await logger.logClassification(makeClassification({ messageText: withBidi }));
		const content = await readLog(dir);
		expect(content).not.toContain('⁦');
		expect(content).not.toContain('⁩');
	});

	it('strips U+200B (ZERO WIDTH SPACE)', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		const withZwsp = 'zero​width';
		await logger.logClassification(makeClassification({ messageText: withZwsp }));
		const content = await readLog(dir);
		expect(content).not.toContain('​');
	});

	it('handles combined hostile input: </script> + backtick + bidi + newline', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		const hostile = '</script>‮`alert(1)`⁦<img>\n</style>';
		await logger.logClassification(makeClassification({ messageText: hostile }));
		const content = await readLog(dir);
		expect(content).not.toContain('</script>');
		expect(content).not.toContain('</style>');
		expect(content).not.toMatch(/`/);
		expect(content).not.toContain('‮');
		expect(content).not.toContain('⁦');
	});
});

// ─── Error handling (fail-open) ───────────────────────────────────────────────

describe('SessionControlLogger — fail-open', () => {
	it('logger.warn fires and call resolves when writeFile fails with non-EEXIST error (EISDIR)', async () => {
		// Create a directory named session-control-log.md so writeFile gets EISDIR
		// doWrite catches EISDIR (it's not EEXIST), re-throws, outer catch logs + returns
		const logFileName = join(dir, 'session-control-log.md');
		await mkdir(logFileName, { recursive: true });
		const logger = new SessionControlLogger(dir, mockLogger);
		await expect(logger.logClassification(makeClassification())).resolves.toBeUndefined();
		expect(mockLogger.warn).toHaveBeenCalled();
	});

	it('subsequent writes still attempt after a failed write (chain not permanently broken)', async () => {
		// First write: EISDIR triggers fail-open
		const logFileName = join(dir, 'session-control-log.md');
		await mkdir(logFileName, { recursive: true });
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification());
		expect(mockLogger.warn).toHaveBeenCalledTimes(1);

		// Remove the blocking directory, let the second write through a separate logger
		// (the original logger's path is permanently broken due to the directory, so we verify
		// the chain continues by confirming a second call also resolves without throwing)
		await expect(logger.logClassification(makeClassification({ entryId: 'second' }))).resolves.toBeUndefined();
		// warn called again (second write also fails for same reason)
		expect(mockLogger.warn).toHaveBeenCalledTimes(2);
	});
});

// ─── Configuration: enabled: false ───────────────────────────────────────────

describe('SessionControlLogger — enabled: false', () => {
	it('does not create any file when disabled', async () => {
		const logger = new SessionControlLogger(dir, mockLogger, { enabled: false });
		await logger.logClassification(makeClassification());
		await expect(readLog(dir)).rejects.toThrow();
	});

	it('logConfirmation is also a no-op when disabled', async () => {
		const logger = new SessionControlLogger(dir, mockLogger, { enabled: false });
		await logger.logConfirmation(makeConfirmation());
		await expect(readLog(dir)).rejects.toThrow();
	});

	it('enabled: true (explicit) behaves as default (writes)', async () => {
		const logger = new SessionControlLogger(dir, mockLogger, { enabled: true });
		await logger.logClassification(makeClassification());
		const content = await readLog(dir);
		expect(content).toContain('- **Kind**: classification');
	});
});

// ─── logConfirmation ──────────────────────────────────────────────────────────

describe('SessionControlLogger.logConfirmation', () => {
	it('writes a confirmation entry with all required fields', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logConfirmation(makeConfirmation());
		const content = await readLog(dir);
		expect(content).toContain('- **Kind**: confirmation');
		expect(content).toContain('- **User**: u1');
		expect(content).toContain('- **Entry ID**: abc123');
		expect(content).toContain('- **Outcome**: confirmed');
		expect(content).toContain('- **Elapsed**: 5000ms');
	});

	it('writes classification then confirmation — both present in file', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logClassification(makeClassification({ timestamp: new Date('2026-05-07T12:00:00Z') }));
		await logger.logConfirmation(makeConfirmation({ timestamp: new Date('2026-05-07T12:00:05Z') }));
		const content = await readLog(dir);
		const headings = content.match(/^## /gm) ?? [];
		expect(headings).toHaveLength(2);
		expect(content).toContain('- **Kind**: classification');
		expect(content).toContain('- **Kind**: confirmation');
	});

	it('records declined outcome', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logConfirmation(makeConfirmation({ outcome: 'declined' }));
		const content = await readLog(dir);
		expect(content).toContain('- **Outcome**: declined');
	});

	it('records expired-or-stale outcome', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logConfirmation(makeConfirmation({ outcome: 'expired-or-stale', elapsedMs: 0 }));
		const content = await readLog(dir);
		expect(content).toContain('- **Outcome**: expired-or-stale');
	});

	it('records elapsedMs correctly', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		await logger.logConfirmation(makeConfirmation({ elapsedMs: 3500 }));
		const content = await readLog(dir);
		expect(content).toContain('- **Elapsed**: 3500ms');
	});
});

// ─── State transitions: classification → confirmation link ───────────────────

describe('SessionControlLogger — classification+confirmation linkage', () => {
	it('entryId links classification and confirmation entries', async () => {
		const logger = new SessionControlLogger(dir, mockLogger);
		const entryId = 'deadbeef';
		await logger.logClassification(makeClassification({ entryId, zone: 'grey-zone' }));
		await logger.logConfirmation(makeConfirmation({ entryId, outcome: 'confirmed' }));
		const content = await readLog(dir);
		// Both entries must contain the same entryId
		const matches = content.match(/- \*\*Entry ID\*\*: deadbeef/g) ?? [];
		expect(matches).toHaveLength(2);
	});
});

// Round-trip tests live in scripts/__tests__/analyze-session-control-log.test.ts
// which imports SessionControlLogger from core and parseSessionControlLog from scripts.
