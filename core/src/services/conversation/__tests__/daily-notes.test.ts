import { describe, expect, it, vi } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import { appendDailyNote } from '../daily-notes.js';

describe('appendDailyNote', () => {
	it('writes to the user store with frontmatter (happy path)', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);

		const ctx = createTestMessageContext({
			text: 'a note',
			timestamp: new Date('2026-03-11T14:30:00Z'),
		});
		await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
		});

		expect(store.append).toHaveBeenCalledTimes(1);
		const call = vi.mocked(store.append).mock.calls[0];
		expect(call?.[0]).toMatch(/^daily-notes\/\d{4}-\d{2}-\d{2}\.md$/);
		expect(call?.[1]).toContain('a note');
		const opts = call?.[2] as { frontmatter?: string } | undefined;
		expect(opts?.frontmatter).toMatch(/---/);
		expect(opts?.frontmatter).toMatch(/pas\/daily-note/);
	});

	it('logs and continues when store.append throws (graceful)', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(store.append).mockRejectedValue(new Error('disk full'));
		vi.mocked(services.data.forUser).mockReturnValue(store);

		const ctx = createTestMessageContext({ text: 'note' });

		await expect(
			appendDailyNote(ctx, {
				data: services.data,
				logger: services.logger,
				timezone: 'UTC',
			}),
		).resolves.toBeUndefined();
		expect(services.logger.warn).toHaveBeenCalled();
	});

	it('uses configured timezone for date formatting', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);

		// 2026-03-11 02:00 UTC = 2026-03-10 in America/Los_Angeles
		const ctx = createTestMessageContext({
			text: 'note',
			timestamp: new Date('2026-03-11T02:00:00Z'),
		});
		await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'America/Los_Angeles',
		});

		const path = vi.mocked(store.append).mock.calls[0]?.[0];
		expect(path).toBe('daily-notes/2026-03-10.md');
	});
});
