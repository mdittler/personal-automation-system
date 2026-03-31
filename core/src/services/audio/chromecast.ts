/**
 * Chromecast audio casting wrapper.
 *
 * Spawns a Python script that uses pychromecast to cast
 * an MP3 file to a named Chromecast/Google Home device.
 */

import type { Logger } from 'pino';
import { execFileAsync } from './subprocess.js';

export interface CastAudioOptions {
	castScriptPath?: string;
	logger: Logger;
}

/**
 * Cast an MP3 file to a Chromecast device.
 * @throws If Python or the cast script is not found, or casting fails.
 */
export async function castAudio(
	mp3Path: string,
	device: string,
	options: CastAudioOptions,
): Promise<void> {
	const scriptPath = options.castScriptPath ?? 'scripts/cast.py';

	await execFileAsync('python3', [scriptPath, mp3Path, device]);
}
