/**
 * Multi-intent reply collector ("Option B").
 *
 * Buffers plain `send` calls per userId during `Router.tryMultiIntentSplit`
 * and emits them as a single (or as few as possible) Telegram message(s) on
 * `flushPending`. Rich sends (`sendPhoto`/`sendWithButtons`/`sendOptions`)
 * implicitly flush the buffer first, then pass through. `editMessage` is
 * order-independent (targets a specific prior message id) and bypasses the
 * buffer entirely (REQ-ROUTE-019b).
 *
 * Codex Round 1 #3: the constructor's `inner` MUST be the REAL transport.
 * If it were the `ContextAwareTelegramService` wrapper, the wrapper would
 * re-enter the buffer via `requestContext.getStore()?.replyBuffer`, causing
 * infinite recursion on flush. The compose-runtime split keeps the real
 * transport as a separate handle so Router can pass it in unwrapped.
 *
 * Implements REQ-ROUTE-017/018/019/019b/020/021.
 */

import type { InlineButton, SentMessage, TelegramService } from '../../types/telegram.js';
import type { FlushableTelegramProxy } from './reply-buffer-types.js';

export interface BufferingTelegramProxyOpts {
	readonly inner: TelegramService;
	/**
	 * Max characters per outgoing Telegram message. Default 4000 (Telegram's
	 * hard cap is 4096; we leave headroom for Markdown escapes and trailing
	 * whitespace).
	 */
	readonly maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 4000;
const SEGMENT_SEPARATOR = '\n\n';

export class BufferingTelegramProxy implements FlushableTelegramProxy {
	private readonly inner: TelegramService;
	private readonly maxLength: number;
	private readonly buffers = new Map<string, string[]>();

	constructor(opts: BufferingTelegramProxyOpts) {
		this.inner = opts.inner;
		this.maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
	}

	async send(userId: string, message: string): Promise<void> {
		let buf = this.buffers.get(userId);
		if (!buf) {
			buf = [];
			this.buffers.set(userId, buf);
		}
		buf.push(message);
	}

	async sendPhoto(userId: string, photo: Buffer, caption?: string): Promise<void> {
		await this.flushPending(userId);
		return this.inner.sendPhoto(userId, photo, caption);
	}

	async sendOptions(userId: string, prompt: string, options: string[]): Promise<string> {
		await this.flushPending(userId);
		return this.inner.sendOptions(userId, prompt, options);
	}

	async sendWithButtons(
		userId: string,
		text: string,
		buttons: InlineButton[][],
	): Promise<SentMessage> {
		await this.flushPending(userId);
		return this.inner.sendWithButtons(userId, text, buttons);
	}

	async editMessage(
		chatId: number,
		messageId: number,
		text: string,
		buttons?: InlineButton[][],
	): Promise<void> {
		// REQ-ROUTE-019b: editMessage targets a prior message id; bypass the
		// buffer entirely. Note we use the buffer-owner's `chatId` argument,
		// not a userId — the chatId is sufficient for Telegram routing.
		return this.inner.editMessage(chatId, messageId, text, buttons);
	}

	async flushPending(userId: string): Promise<void> {
		const buf = this.buffers.get(userId);
		// REQ-ROUTE-021: clear up-front so a rejected send doesn't double-emit
		// the same pending text on a subsequent flush.
		this.buffers.delete(userId);
		if (!buf || buf.length === 0) return;

		const chunks = packSegments(buf, this.maxLength);
		for (const chunk of chunks) {
			await this.inner.send(userId, chunk);
		}
	}
}

/**
 * Pack ordered segments into output chunks, each ≤ maxLength. Boundaries
 * fall between segments wherever possible; a single segment longer than
 * maxLength is hard-split into raw maxLength-sized slices (content is
 * preserved in order).
 *
 * Exported for direct unit testing.
 */
export function packSegments(segments: string[], maxLength: number): string[] {
	const out: string[] = [];
	let current = '';
	for (const seg of segments) {
		if (seg.length > maxLength) {
			// Flush current first
			if (current) {
				out.push(current);
				current = '';
			}
			// Hard-split the oversize segment
			for (let i = 0; i < seg.length; i += maxLength) {
				out.push(seg.slice(i, i + maxLength));
			}
			continue;
		}
		const candidate = current ? `${current}${SEGMENT_SEPARATOR}${seg}` : seg;
		if (candidate.length <= maxLength) {
			current = candidate;
		} else {
			out.push(current);
			current = seg;
		}
	}
	if (current) out.push(current);
	return out;
}
