import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMService } from '../../../types/llm.js';
import { ensureDir } from '../../../utils/file.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { DailyDiffService } from '../index.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

function createMockLLM(response = 'Test summary'): LLMService {
	return {
		complete: vi.fn().mockResolvedValue(response),
		classify: vi.fn().mockResolvedValue({ category: 'test', confidence: 1 }),
		extractStructured: vi.fn().mockResolvedValue({}),
	};
}

describe('DailyDiffService', () => {
	let tempDir: string;
	let changeLog: ChangeLog;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-daily-diff-'));
		changeLog = new ChangeLog(tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function writeLogEntries(
		entries: Array<{
			timestamp: string;
			operation: string;
			path: string;
			appId: string;
			userId: string;
		}>,
	): Promise<void> {
		await ensureDir(join(tempDir, 'system'));
		const lines = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
		await writeFile(changeLog.getLogPath(), lines);
	}

	it('should produce a markdown report from change log entries', async () => {
		await writeLogEntries([
			{
				timestamp: '2026-03-09T10:00:00.000Z',
				operation: 'write',
				path: 'log.md',
				appId: 'echo',
				userId: 'user1',
			},
			{
				timestamp: '2026-03-09T11:00:00.000Z',
				operation: 'append',
				path: 'log.md',
				appId: 'echo',
				userId: 'user1',
			},
			{
				timestamp: '2026-03-09T14:00:00.000Z',
				operation: 'write',
				path: 'preferences.md',
				appId: 'weather',
				userId: 'user2',
			},
		]);

		const service = new DailyDiffService({
			dataDir: tempDir,
			changeLog,
			llm: createMockLLM(),
			logger: createMockLogger(),
		});

		await service.run(new Date('2026-03-09T00:00:00.000Z'));

		const reportPath = join(tempDir, 'system', 'daily-diff', '2026-03-09.md');
		const content = await readFile(reportPath, 'utf-8');

		expect(content).toContain('# Daily Diff — 2026-03-09');
		expect(content).toContain('## Summary');
		expect(content).toContain('No summary generated.');
		expect(content).toContain('## Changes');
		expect(content).toContain('### echo');
		expect(content).toContain('**user1**: write log.md, append log.md');
		expect(content).toContain('### weather');
		expect(content).toContain('**user2**: write preferences.md');
	});

	it('should include LLM summary when summarization is enabled', async () => {
		await writeLogEntries([
			{
				timestamp: '2026-03-09T10:00:00.000Z',
				operation: 'write',
				path: 'log.md',
				appId: 'echo',
				userId: 'user1',
			},
		]);

		const llm = createMockLLM('User echoed a message and it was logged.');
		const service = new DailyDiffService({
			dataDir: tempDir,
			changeLog,
			llm,
			logger: createMockLogger(),
			enableSummarization: true,
		});

		await service.run(new Date('2026-03-09T00:00:00.000Z'));

		const reportPath = join(tempDir, 'system', 'daily-diff', '2026-03-09.md');
		const content = await readFile(reportPath, 'utf-8');

		expect(content).toContain('User echoed a message and it was logged.');
		expect(content).not.toContain('No summary generated.');
		expect(llm.complete).toHaveBeenCalled();
	});

	it('should not write a report when there are no changes', async () => {
		const logger = createMockLogger();
		const service = new DailyDiffService({
			dataDir: tempDir,
			changeLog,
			llm: createMockLLM(),
			logger,
		});

		await service.run(new Date('2026-03-09T00:00:00.000Z'));

		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({ date: '2026-03-09' }),
			'No changes to report',
		);
	});

	it('should filter out entries before the since date', async () => {
		await writeLogEntries([
			{
				timestamp: '2026-03-08T10:00:00.000Z',
				operation: 'write',
				path: 'old.md',
				appId: 'echo',
				userId: 'user1',
			},
			{
				timestamp: '2026-03-09T10:00:00.000Z',
				operation: 'write',
				path: 'new.md',
				appId: 'echo',
				userId: 'user1',
			},
		]);

		const service = new DailyDiffService({
			dataDir: tempDir,
			changeLog,
			llm: createMockLLM(),
			logger: createMockLogger(),
		});

		await service.run(new Date('2026-03-09T00:00:00.000Z'));

		const reportPath = join(tempDir, 'system', 'daily-diff', '2026-03-09.md');
		const content = await readFile(reportPath, 'utf-8');

		expect(content).toContain('new.md');
		expect(content).not.toContain('old.md');
	});

	it('should gracefully handle LLM failure with summarization enabled', async () => {
		await writeLogEntries([
			{
				timestamp: '2026-03-09T10:00:00.000Z',
				operation: 'write',
				path: 'log.md',
				appId: 'echo',
				userId: 'user1',
			},
		]);

		const llm = createMockLLM();
		vi.mocked(llm.complete).mockRejectedValue(new Error('API error'));

		const service = new DailyDiffService({
			dataDir: tempDir,
			changeLog,
			llm,
			logger: createMockLogger(),
			enableSummarization: true,
		});

		await service.run(new Date('2026-03-09T00:00:00.000Z'));

		const reportPath = join(tempDir, 'system', 'daily-diff', '2026-03-09.md');
		const content = await readFile(reportPath, 'utf-8');

		expect(content).toContain('No summary generated.');
		expect(content).toContain('### echo');
	});
});
