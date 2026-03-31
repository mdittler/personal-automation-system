/**
 * Audio service implementation.
 *
 * Chains Piper TTS → FFmpeg WAV→MP3 → Chromecast casting.
 * Best-effort: failures are logged but never thrown to callers.
 */

import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AudioService } from '../../types/audio.js';
import { castAudio } from './chromecast.js';
import { wavToMp3 } from './ffmpeg.js';
import { piperTts } from './piper-tts.js';

export interface AudioServiceOptions {
	logger: Logger;
	defaultDevice?: string;
	piperVoice?: string;
	piperPath?: string;
	ffmpegPath?: string;
	castScriptPath?: string;
}

export class AudioServiceImpl implements AudioService {
	private readonly logger: Logger;
	private readonly defaultDevice?: string;
	private readonly piperVoice?: string;
	private readonly piperPath?: string;
	private readonly ffmpegPath?: string;
	private readonly castScriptPath?: string;

	constructor(options: AudioServiceOptions) {
		this.logger = options.logger;
		this.defaultDevice = options.defaultDevice;
		this.piperVoice = options.piperVoice;
		this.piperPath = options.piperPath;
		this.ffmpegPath = options.ffmpegPath;
		this.castScriptPath = options.castScriptPath;
	}

	async tts(text: string): Promise<Buffer> {
		return piperTts(text, {
			piperPath: this.piperPath,
			voice: this.piperVoice,
			logger: this.logger,
		});
	}

	async speak(text: string, device?: string): Promise<void> {
		const targetDevice = device ?? this.defaultDevice;
		if (!targetDevice) {
			this.logger.warn('No Chromecast device specified and no default configured — skipping');
			return;
		}

		let mp3Path: string | undefined;

		try {
			const wavBuffer = await piperTts(text, {
				piperPath: this.piperPath,
				voice: this.piperVoice,
				logger: this.logger,
			});

			const mp3Buffer = await wavToMp3(wavBuffer, {
				ffmpegPath: this.ffmpegPath,
				logger: this.logger,
			});

			mp3Path = join(tmpdir(), `pas-speak-${randomBytes(6).toString('hex')}.mp3`);
			await writeFile(mp3Path, mp3Buffer);

			await castAudio(mp3Path, targetDevice, {
				castScriptPath: this.castScriptPath,
				logger: this.logger,
			});

			this.logger.debug({ device: targetDevice }, 'Audio cast complete');
		} catch (error) {
			this.logger.error({ error, device: targetDevice }, 'Audio speak failed');
		} finally {
			if (mp3Path) {
				await unlink(mp3Path).catch(() => {});
			}
		}
	}
}
