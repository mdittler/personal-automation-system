import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../types/config.js';
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import { appendDailyNote } from '../daily-notes.js';

function makeConfig(overrides: Record<string, unknown> | null): AppConfigService {
	return {
		get: vi.fn(),
		getAll: vi.fn(),
		getOverrides: vi.fn().mockResolvedValue(overrides),
		setAll: vi.fn(),
		updateOverrides: vi.fn(),
	} as unknown as AppConfigService;
}

const optedInConfig = makeConfig({ log_to_notes: true });
const optedOutConfig = makeConfig({ log_to_notes: false });
const noOverrideConfig = makeConfig(null);

describe('appendDailyNote — opt-in behavior', () => {
	it('writes and returns { wrote: true } when user has opted in', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);

		const ctx = createTestMessageContext({ text: 'a note', timestamp: new Date('2026-03-11T14:30:00Z') });
		const result = await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			config: optedInConfig,
			systemDefault: false,
		});

		expect(result).toEqual({ wrote: true });
		expect(store.append).toHaveBeenCalledTimes(1);
	});

	it('returns { wrote: false } and does NOT write when user has opted out (default)', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);

		const ctx = createTestMessageContext({ text: 'a note' });
		const result = await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			config: optedOutConfig,
			systemDefault: false,
		});

		expect(result).toEqual({ wrote: false });
		expect(store.append).not.toHaveBeenCalled();
	});

	it('uses systemDefault when no user override exists', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);

		const ctx = createTestMessageContext({ text: 'a note' });

		// systemDefault: true → writes
		const resultOn = await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			config: noOverrideConfig,
			systemDefault: true,
		});
		expect(resultOn).toEqual({ wrote: true });
		expect(store.append).toHaveBeenCalledTimes(1);

		store.append.mockClear();

		// systemDefault: false → does not write
		const resultOff = await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			config: noOverrideConfig,
			systemDefault: false,
		});
		expect(resultOff).toEqual({ wrote: false });
		expect(store.append).not.toHaveBeenCalled();
	});

	it('user override false beats systemDefault true', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);

		const ctx = createTestMessageContext({ text: 'a note' });
		const result = await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			config: optedOutConfig,
			systemDefault: true,
		});

		expect(result).toEqual({ wrote: false });
		expect(store.append).not.toHaveBeenCalled();
	});

	it('defaults to systemDefault: false when config is omitted', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);

		const ctx = createTestMessageContext({ text: 'a note' });
		const result = await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			// no config, no systemDefault
		});

		expect(result).toEqual({ wrote: false });
		expect(store.append).not.toHaveBeenCalled();
	});
});

describe('appendDailyNote — happy path content', () => {
	it('writes to the user store with correct path and frontmatter', async () => {
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
			config: optedInConfig,
			systemDefault: false,
		});

		expect(store.append).toHaveBeenCalledTimes(1);
		const call = vi.mocked(store.append).mock.calls[0];
		expect(call?.[0]).toMatch(/^daily-notes\/\d{4}-\d{2}-\d{2}\.md$/);
		expect(call?.[1]).toContain('a note');
		const opts = call?.[2] as { frontmatter?: string } | undefined;
		expect(opts?.frontmatter).toMatch(/---/);
		expect(opts?.frontmatter).toMatch(/pas\/daily-note/);
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
			config: optedInConfig,
			systemDefault: false,
		});

		const path = vi.mocked(store.append).mock.calls[0]?.[0];
		expect(path).toBe('daily-notes/2026-03-10.md');
	});
});

describe('appendDailyNote — error handling', () => {
	it('logs warn and returns { wrote: false } when store.append throws', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(store.append).mockRejectedValue(new Error('disk full'));
		vi.mocked(services.data.forUser).mockReturnValue(store);

		const ctx = createTestMessageContext({ text: 'note' });

		const result = await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			config: optedInConfig,
			systemDefault: false,
		});

		expect(result).toEqual({ wrote: false });
		expect(services.logger.warn).toHaveBeenCalled();
	});

	it('never throws — always returns { wrote: boolean }', async () => {
		const badConfig = {
			get: vi.fn(),
			getAll: vi.fn(),
			getOverrides: vi.fn().mockRejectedValue(new Error('io error')),
			setAll: vi.fn(),
			updateOverrides: vi.fn(),
		} as unknown as AppConfigService;

		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);
		const ctx = createTestMessageContext({ text: 'note' });

		const result = await appendDailyNote(ctx, {
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			config: badConfig,
			systemDefault: true,
		});

		// resolveUserBool catches the error and returns systemDefault (true)
		// so append IS attempted, and store.append succeeds (mock default)
		expect(typeof result.wrote).toBe('boolean');
	});
});
