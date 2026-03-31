/**
 * Audio service types.
 *
 * Text-to-speech via Piper TTS (local) and speaker casting
 * via pychromecast. Audio is best-effort and non-blocking.
 */

/** Audio service provided to apps via CoreServices. */
export interface AudioService {
	/**
	 * Convert text to speech and cast to a Google Home speaker.
	 * Best-effort: if the speaker is unavailable, logs failure and returns.
	 * @param text - The text to speak.
	 * @param device - Target Chromecast device name. Uses default if omitted.
	 */
	speak(text: string, device?: string): Promise<void>;

	/**
	 * Convert text to speech and return the audio buffer.
	 * Useful for sending as a Telegram voice note.
	 */
	tts(text: string): Promise<Buffer>;
}
