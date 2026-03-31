import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioServiceImpl } from '../index.js';

// Mock the subprocess module so no real binaries are spawned
vi.mock('../subprocess.js', () => ({
	execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

// Mock fs/promises for temp file operations in piper-tts, ffmpeg, and speak
vi.mock('node:fs/promises', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...original,
		readFile: vi.fn().mockResolvedValue(Buffer.from('fake-audio-data')),
		writeFile: vi.fn().mockResolvedValue(undefined),
		unlink: vi.fn().mockResolvedValue(undefined),
	};
});

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { execFileAsync } from '../subprocess.js';

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

describe('AudioServiceImpl', () => {
	let logger: Logger;

	beforeEach(() => {
		logger = createMockLogger();
		vi.clearAllMocks();
		// Re-establish default mock behavior after clearAllMocks
		vi.mocked(execFileAsync).mockResolvedValue({ stdout: '', stderr: '' });
		vi.mocked(readFile).mockResolvedValue(Buffer.from('fake-audio-data'));
		vi.mocked(writeFile).mockResolvedValue(undefined);
		vi.mocked(unlink).mockResolvedValue(undefined);
	});

	describe('tts', () => {
		it('should spawn Piper with correct arguments', async () => {
			const service = new AudioServiceImpl({ logger });

			await service.tts('Hello world');

			expect(execFileAsync).toHaveBeenCalledWith(
				'piper',
				expect.arrayContaining(['--model', 'en_US-lessac-medium', '--output_file']),
			);
		});

		it('should use custom Piper path and voice', async () => {
			const service = new AudioServiceImpl({
				logger,
				piperPath: '/usr/local/bin/piper',
				piperVoice: 'en_GB-alba-medium',
			});

			await service.tts('Hello world');

			expect(execFileAsync).toHaveBeenCalledWith(
				'/usr/local/bin/piper',
				expect.arrayContaining(['--model', 'en_GB-alba-medium']),
			);
		});

		it('should return the WAV buffer', async () => {
			const service = new AudioServiceImpl({ logger });

			const result = await service.tts('Hello');

			expect(Buffer.isBuffer(result)).toBe(true);
		});

		it('should clean up temp files even on failure', async () => {
			vi.mocked(execFileAsync).mockRejectedValue(new Error('piper not found'));
			const service = new AudioServiceImpl({ logger });

			await expect(service.tts('Hello')).rejects.toThrow('piper not found');
			expect(unlink).toHaveBeenCalled();
		});

		it('should pass text to Piper via stdin temp file', async () => {
			const service = new AudioServiceImpl({ logger });

			await service.tts('Test sentence');

			expect(writeFile).toHaveBeenCalled();
			const writeCall = vi.mocked(writeFile).mock.calls[0];
			expect(writeCall?.[1]).toBe('Test sentence');
		});
	});

	describe('speak', () => {
		it('should chain TTS, FFmpeg, and Chromecast', async () => {
			const service = new AudioServiceImpl({
				logger,
				defaultDevice: 'Kitchen Speaker',
			});

			await service.speak('Good morning');

			// First call: piper TTS
			expect(execFileAsync).toHaveBeenCalledWith('piper', expect.arrayContaining(['--model']));

			// Second call: ffmpeg
			expect(execFileAsync).toHaveBeenCalledWith(
				'ffmpeg',
				expect.arrayContaining(['-codec:a', 'libmp3lame']),
			);

			// Third call: python3 cast script
			expect(execFileAsync).toHaveBeenCalledWith(
				'python3',
				expect.arrayContaining(['Kitchen Speaker']),
			);
		});

		it('should use explicit device over default', async () => {
			const service = new AudioServiceImpl({
				logger,
				defaultDevice: 'Kitchen Speaker',
			});

			await service.speak('Hello', 'Bedroom Speaker');

			expect(execFileAsync).toHaveBeenCalledWith(
				'python3',
				expect.arrayContaining(['Bedroom Speaker']),
			);
		});

		it('should warn and skip when no device is configured', async () => {
			const service = new AudioServiceImpl({ logger });

			await service.speak('Hello');

			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No Chromecast device'));
			expect(execFileAsync).not.toHaveBeenCalled();
		});

		it('should log error but not throw on subprocess failure', async () => {
			vi.mocked(execFileAsync).mockRejectedValue(new Error('binary not found'));
			const service = new AudioServiceImpl({
				logger,
				defaultDevice: 'Kitchen Speaker',
			});

			// Should not throw
			await service.speak('Hello');

			expect(logger.error).toHaveBeenCalledWith(
				expect.objectContaining({ error: expect.any(Error) }),
				'Audio speak failed',
			);
		});

		it('should clean up temp MP3 file even on failure', async () => {
			// Make piper succeed but ffmpeg fail
			let callCount = 0;
			vi.mocked(execFileAsync).mockImplementation(async () => {
				callCount++;
				if (callCount === 2) {
					throw new Error('ffmpeg failed');
				}
				return { stdout: '', stderr: '' };
			});

			const service = new AudioServiceImpl({
				logger,
				defaultDevice: 'Kitchen Speaker',
			});

			await service.speak('Hello');

			// unlink should still have been called for cleanup
			expect(unlink).toHaveBeenCalled();
		});
	});
});
