import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { stripFrontmatter } from '../../../utils/frontmatter.js';
import { FallbackHandler } from '../fallback.js';

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

function createMockTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
	};
}

describe('FallbackHandler', () => {
	let tempDir: string;
	let logger: Logger;
	let telegram: TelegramService;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-fallback-'));
		logger = createMockLogger();
		telegram = createMockTelegram();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('should append message to daily notes file', async () => {
		const handler = new FallbackHandler({ dataDir: tempDir, timezone: 'UTC', logger });
		const ctx: MessageContext = {
			userId: 'user123',
			text: 'some unrecognized message',
			timestamp: new Date('2026-02-27T14:30:00Z'),
			chatId: 123,
			messageId: 456,
		};

		await handler.handleUnrecognized(ctx, telegram);

		const notesPath = join(tempDir, 'users', 'user123', 'daily-notes', '2026-02-27.md');
		const content = await readFile(notesPath, 'utf-8');
		expect(content).toContain('some unrecognized message');
		expect(content).toMatch(/- \[\d{2}:\d{2}\] some unrecognized message/);
	});

	it('should append multiple messages to the same daily file', async () => {
		const handler = new FallbackHandler({ dataDir: tempDir, timezone: 'UTC', logger });
		const baseCtx: MessageContext = {
			userId: 'user123',
			text: '',
			timestamp: new Date('2026-02-27T10:00:00Z'),
			chatId: 123,
			messageId: 1,
		};

		await handler.handleUnrecognized({ ...baseCtx, text: 'first message' }, telegram);
		await handler.handleUnrecognized(
			{ ...baseCtx, text: 'second message', messageId: 2 },
			telegram,
		);

		const notesPath = join(tempDir, 'users', 'user123', 'daily-notes', '2026-02-27.md');
		const content = await readFile(notesPath, 'utf-8');
		const lines = stripFrontmatter(content).trim().split('\n');
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('first message');
		expect(lines[1]).toContain('second message');
	});

	it('should send acknowledgment to user', async () => {
		const handler = new FallbackHandler({ dataDir: tempDir, timezone: 'UTC', logger });
		const ctx: MessageContext = {
			userId: 'user123',
			text: 'random note',
			timestamp: new Date(),
			chatId: 123,
			messageId: 456,
		};

		await handler.handleUnrecognized(ctx, telegram);

		expect(telegram.send).toHaveBeenCalledWith('user123', expect.stringContaining('daily notes'));
	});

	it('should not throw if telegram.send fails', async () => {
		const failTelegram = createMockTelegram();
		vi.mocked(failTelegram.send).mockRejectedValue(new Error('network error'));

		const handler = new FallbackHandler({ dataDir: tempDir, timezone: 'UTC', logger });
		const ctx: MessageContext = {
			userId: 'user123',
			text: 'a message',
			timestamp: new Date(),
			chatId: 123,
			messageId: 456,
		};

		// Should not throw
		await handler.handleUnrecognized(ctx, failTelegram);

		expect(logger.error).toHaveBeenCalled();
	});
});
