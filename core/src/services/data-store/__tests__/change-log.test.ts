import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeLogEntry } from '../../../types/data-store.js';
import { ChangeLog } from '../change-log.js';

let tempDir: string;
let changeLog: ChangeLog;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-changelog-'));
	changeLog = new ChangeLog(tempDir);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('ChangeLog', () => {
	it('creates the log file on first record', async () => {
		await changeLog.record('write', 'grocery/list.md', 'grocery', 'user-1');

		const logPath = changeLog.getLogPath();
		const content = await readFile(logPath, 'utf-8');
		expect(content.trim().length).toBeGreaterThan(0);
	});

	it('writes JSONL format (one JSON object per line)', async () => {
		await changeLog.record('write', 'file1.md', 'app-a', 'user-1');
		await changeLog.record('append', 'file2.md', 'app-b', 'user-2');

		const logPath = changeLog.getLogPath();
		const content = await readFile(logPath, 'utf-8');
		const lines = content.trim().split('\n');

		expect(lines).toHaveLength(2);

		// Each line should be valid JSON
		const entry1 = JSON.parse(lines[0] ?? '') as ChangeLogEntry;
		const entry2 = JSON.parse(lines[1] ?? '') as ChangeLogEntry;

		expect(entry1.operation).toBe('write');
		expect(entry1.path).toBe('file1.md');
		expect(entry1.appId).toBe('app-a');
		expect(entry1.userId).toBe('user-1');
		expect(entry1.timestamp).toBeTruthy();

		expect(entry2.operation).toBe('append');
		expect(entry2.path).toBe('file2.md');
		expect(entry2.appId).toBe('app-b');
		expect(entry2.userId).toBe('user-2');
	});

	it('records all operation types', async () => {
		await changeLog.record('read', 'a.md', 'app', 'user');
		await changeLog.record('write', 'b.md', 'app', 'user');
		await changeLog.record('append', 'c.md', 'app', 'user');
		await changeLog.record('archive', 'd.md', 'app', 'user');

		const logPath = changeLog.getLogPath();
		const content = await readFile(logPath, 'utf-8');
		const entries = content
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as ChangeLogEntry);

		expect(entries.map((e) => e.operation)).toEqual(['read', 'write', 'append', 'archive']);
	});

	it('includes app ID when provided', async () => {
		await changeLog.record('write', 'grocery/list.md', 'grocery', 'user-1');

		const logPath = changeLog.getLogPath();
		const content = await readFile(logPath, 'utf-8');
		const entry = JSON.parse(content.trim()) as ChangeLogEntry;

		expect(entry.appId).toBe('grocery');
	});

	it('uses "system" for null userId', async () => {
		await changeLog.record('write', 'shared.md', 'app', null);

		const logPath = changeLog.getLogPath();
		const content = await readFile(logPath, 'utf-8');
		const entry = JSON.parse(content.trim()) as ChangeLogEntry;

		expect(entry.userId).toBe('system');
	});

	it('records ISO 8601 timestamps', async () => {
		await changeLog.record('write', 'test.md', 'app', 'user');

		const logPath = changeLog.getLogPath();
		const content = await readFile(logPath, 'utf-8');
		const entry = JSON.parse(content.trim()) as ChangeLogEntry;

		// ISO 8601 format check
		expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it('returns the correct log path', () => {
		const logPath = changeLog.getLogPath();
		expect(logPath).toBe(join(tempDir, 'system', 'change-log.jsonl'));
	});

	it('handles concurrent record() calls without losing entries', async () => {
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				changeLog.record('write', `file-${i}.md`, 'app', 'user'),
			),
		);

		const logPath = changeLog.getLogPath();
		const content = await readFile(logPath, 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines).toHaveLength(10);

		// Each line should be valid JSON
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});
});
