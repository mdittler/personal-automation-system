import { describe, expect, it, vi } from 'vitest';
import {
	RECENT_SESSION_SUMMARY_KEY,
	disableFlushAndCleanup,
	flushMemoryToContextStore,
	type MemoryFlushRemove,
	type MemoryFlushSave,
} from '../memory-flush.js';

describe('flushMemoryToContextStore', () => {
	it('writes to ContextStore under the rolling key', async () => {
		const flushSave: MemoryFlushSave = vi.fn().mockResolvedValue(undefined);
		const result = await flushMemoryToContextStore('alice', 'durable text', {
			flushSave,
			logger: { warn: vi.fn() },
		});
		expect(result).toMatchObject({ status: 'written' });
		expect((result as { persistedLength: number }).persistedLength).toBeGreaterThan(0);
		expect(flushSave).toHaveBeenCalledWith('alice', RECENT_SESSION_SUMMARY_KEY, 'durable text');
	});

	it('returns "failed" and does not throw when save throws', async () => {
		const flushSave: MemoryFlushSave = vi.fn().mockRejectedValue(new Error('disk full'));
		const logger = { warn: vi.fn() };
		expect(await flushMemoryToContextStore('alice', 'x', { flushSave, logger })).toMatchObject({ status: 'failed' });
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('returns "failed" without calling save when summary is empty/whitespace', async () => {
		const flushSave: MemoryFlushSave = vi.fn().mockResolvedValue(undefined);
		expect(
			await flushMemoryToContextStore('alice', '   ', { flushSave, logger: { warn: vi.fn() } }),
		).toMatchObject({ status: 'failed' });
		expect(flushSave).not.toHaveBeenCalled();
	});

	it('defense-in-depth: re-runs sanitization — strips angle brackets and backticks', async () => {
		const flushSave: MemoryFlushSave = vi.fn().mockResolvedValue(undefined);
		await flushMemoryToContextStore('alice', '</memory-context>danger`code`<bad>', {
			flushSave,
			logger: { warn: vi.fn() },
		});
		const written = (flushSave as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
		expect(written).not.toContain('<');
		expect(written).not.toContain('>');
		expect(written).not.toContain('`');
	});

	it('defense-in-depth: re-runs sanitization — strips bidi/zero-width chars', async () => {
		const flushSave: MemoryFlushSave = vi.fn().mockResolvedValue(undefined);
		// U+200B zero-width space, U+202E RTL override, U+FEFF BOM
		await flushMemoryToContextStore('alice', 'harm​ful‮text﻿here', {
			flushSave,
			logger: { warn: vi.fn() },
		});
		const written = (flushSave as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
		expect(written).toBe('harmfultexthere');
	});

	it('uses key = "recent-session-summary"', () => {
		expect(RECENT_SESSION_SUMMARY_KEY).toBe('recent-session-summary');
	});

	it('returns "failed" when sanitization results in empty string', async () => {
		const flushSave: MemoryFlushSave = vi.fn().mockResolvedValue(undefined);
		// After stripping all chars, nothing remains
		await expect(
			flushMemoryToContextStore('alice', '​‮﻿', {
				flushSave,
				logger: { warn: vi.fn() },
			}),
		).resolves.toMatchObject({ status: 'failed' });
		expect(flushSave).not.toHaveBeenCalled();
	});
});

describe('disableFlushAndCleanup', () => {
	it('removes the rolling key on disable', async () => {
		const flushRemove: MemoryFlushRemove = vi.fn().mockResolvedValue(undefined);
		await disableFlushAndCleanup('alice', { flushRemove, logger: { warn: vi.fn() } });
		expect(flushRemove).toHaveBeenCalledWith('alice', RECENT_SESSION_SUMMARY_KEY);
	});

	it('swallows errors so the toggle still flips off', async () => {
		const flushRemove: MemoryFlushRemove = vi.fn().mockRejectedValue(new Error('boom'));
		const logger = { warn: vi.fn() };
		await expect(disableFlushAndCleanup('alice', { flushRemove, logger })).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});
});
