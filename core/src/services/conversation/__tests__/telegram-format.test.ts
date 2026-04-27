import { describe, expect, it, vi } from 'vitest';
import type { AppLogger, TelegramService } from '../../../types/app-module.js';
import { sendSplitResponse, splitTelegramMessage, stripMarkdown } from '../telegram-format.js';

function makeLogger(): AppLogger {
	const logger: AppLogger = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(),
	};
	vi.mocked(logger.child).mockReturnValue(logger);
	return logger;
}

function makeTelegram(overrides?: Partial<TelegramService>): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
		sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 2 }),
		editMessage: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as TelegramService;
}

describe('splitTelegramMessage', () => {
	it('returns the original message when under maxLength (happy path)', () => {
		const text = 'short message';
		expect(splitTelegramMessage(text, 100)).toEqual(['short message']);
	});

	it('returns single chunk when message is exactly at maxLength boundary', () => {
		const text = 'a'.repeat(3800);
		expect(splitTelegramMessage(text, 3800)).toEqual([text]);
	});

	it('splits a message over the limit at paragraph boundaries when possible', () => {
		const part1 = 'First paragraph.';
		const part2 = 'b'.repeat(50);
		const text = `${part1}\n\n${part2}`;
		const chunks = splitTelegramMessage(text, 30);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toBe(part1);
		expect(chunks.join('')).toContain(part2);
	});

	it('falls back to line boundaries when no paragraph break exists', () => {
		// part1 must be < maxLength so the splitter can use the line break
		// at the end of part1 as the split point.
		const part1 = 'First short line';
		const part2 = 'b'.repeat(50);
		const text = `${part1}\n${part2}`;
		const chunks = splitTelegramMessage(text, 30);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toBe(part1);
	});

	it('hard-chunks when neither paragraph nor line break exists', () => {
		const text = 'a'.repeat(50);
		const chunks = splitTelegramMessage(text, 20);
		expect(chunks.length).toBeGreaterThan(1);
		// All chunks join back to original
		expect(chunks.join('').length).toBe(text.length);
	});

	it('handles a 5000-char message and produces non-empty chunks', () => {
		const text = 'paragraph.\n\n'.repeat(500); // ~6000 chars
		const chunks = splitTelegramMessage(text, 3800);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(3800);
			expect(c.length).toBeGreaterThan(0);
		}
	});

	it('does not produce empty parts when input is mostly blank lines', () => {
		const text = `${'\n\n'.repeat(200)}Final content`;
		const result = splitTelegramMessage(text);
		for (const part of result) {
			expect(part.trim()).not.toBe('');
		}
	});

	it('preserves all content across splits', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: some content here`);
		const text = lines.join('\n');
		const parts = splitTelegramMessage(text);
		const rejoined = parts.join('\n');
		for (const line of lines) {
			expect(rejoined).toContain(line);
		}
	});
});

describe('stripMarkdown', () => {
	it('strips fenced code blocks but preserves their content', () => {
		expect(stripMarkdown('before ```code\ncontent\n``` after')).toContain('content');
		expect(stripMarkdown('```\ncontent\n```')).not.toContain('```');
	});

	it('strips inline code', () => {
		expect(stripMarkdown('use `foo` here')).toBe('use foo here');
	});

	it('strips bold and italic markers', () => {
		expect(stripMarkdown('this is **bold** and *italic*')).toBe('this is bold and italic');
		expect(stripMarkdown('this is __bold__ and _italic_')).toBe('this is bold and italic');
	});
});

describe('sendSplitResponse', () => {
	it('calls telegram.send for each chunk (happy path)', async () => {
		const telegram = makeTelegram();
		const logger = makeLogger();
		const text = 'short';
		await sendSplitResponse('user1', text, { telegram, logger });
		expect(telegram.send).toHaveBeenCalledTimes(1);
		expect(telegram.send).toHaveBeenCalledWith('user1', 'short');
	});

	it('falls back to plain text when telegram.send rejects with a Markdown error', async () => {
		const send = vi
			.fn()
			.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
			.mockResolvedValue(undefined);
		const telegram = makeTelegram({ send });
		const logger = makeLogger();
		await sendSplitResponse('user1', '**bold** message', { telegram, logger });

		// First call rejected, second call retried with stripped text
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1]?.[1]).toBe('bold message');
		expect(logger.warn).toHaveBeenCalled();
	});

	it('splits long responses and sends multiple parts', async () => {
		const telegram = makeTelegram();
		const logger = makeLogger();
		const long = `${'a'.repeat(3500)}\n\n${'b'.repeat(3500)}`;
		await sendSplitResponse('user1', long, { telegram, logger });
		expect(telegram.send).toHaveBeenCalledTimes(2);
	});
});
