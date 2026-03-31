/**
 * FFmpeg WAV-to-MP3 conversion wrapper.
 *
 * Spawns FFmpeg to convert a WAV buffer to MP3 format
 * suitable for Chromecast playback.
 */

import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { execFileAsync } from './subprocess.js';

export interface WavToMp3Options {
	ffmpegPath?: string;
	logger: Logger;
}

/**
 * Convert a WAV buffer to MP3 using FFmpeg.
 * @throws If FFmpeg binary is not found or process fails.
 */
export async function wavToMp3(wavBuffer: Buffer, options: WavToMp3Options): Promise<Buffer> {
	const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
	const suffix = randomBytes(6).toString('hex');
	const inputPath = join(tmpdir(), `pas-wav-${suffix}.wav`);
	const outputPath = join(tmpdir(), `pas-mp3-${suffix}.mp3`);

	try {
		await writeFile(inputPath, wavBuffer);

		await execFileAsync(ffmpegPath, ['-i', inputPath, '-codec:a', 'libmp3lame', '-y', outputPath]);

		const mp3Buffer = await readFile(outputPath);
		return mp3Buffer;
	} finally {
		await unlink(inputPath).catch(() => {});
		await unlink(outputPath).catch(() => {});
	}
}
