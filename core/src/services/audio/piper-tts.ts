/**
 * Piper TTS subprocess wrapper.
 *
 * Spawns the Piper binary to synthesize text into a WAV buffer.
 * Piper is a local, fast neural TTS engine.
 */

import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { execFileAsync } from './subprocess.js';

export interface PiperTtsOptions {
	piperPath?: string;
	voice?: string;
	logger: Logger;
}

/**
 * Synthesize text to a WAV buffer using Piper TTS.
 * @throws If Piper binary is not found or process fails.
 */
export async function piperTts(text: string, options: PiperTtsOptions): Promise<Buffer> {
	const piperPath = options.piperPath ?? 'piper';
	const voice = options.voice ?? 'en_US-lessac-medium';
	const suffix = randomBytes(6).toString('hex');
	const tmpPath = join(tmpdir(), `pas-tts-${suffix}.wav`);

	// Write text to a temp file to avoid shell escaping issues
	const textPath = join(tmpdir(), `pas-tts-${suffix}.txt`);

	try {
		await writeFile(textPath, text, 'utf-8');

		await execFileAsync(piperPath, [
			'--model',
			voice,
			'--output_file',
			tmpPath,
			'--input_file',
			textPath,
		]);

		const wavBuffer = await readFile(tmpPath);
		return wavBuffer;
	} finally {
		// Clean up temp files
		await unlink(tmpPath).catch(() => {});
		await unlink(textPath).catch(() => {});
	}
}
