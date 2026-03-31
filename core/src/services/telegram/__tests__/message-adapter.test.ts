import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { adaptPhotoMessage, adaptTextMessage, extractUserId } from '../message-adapter.js';

function createMockContext(overrides: Partial<Context> = {}): Context {
	return {
		from: { id: 12345, is_bot: false, first_name: 'Test' },
		message: undefined,
		api: {
			token: 'test-token',
			getFile: vi.fn(),
		},
		...overrides,
	} as unknown as Context;
}

describe('extractUserId', () => {
	it('should return user ID as string', () => {
		const ctx = createMockContext({ from: { id: 98765 } as Context['from'] });
		expect(extractUserId(ctx)).toBe('98765');
	});

	it('should return null when no from field', () => {
		const ctx = createMockContext({ from: undefined });
		expect(extractUserId(ctx)).toBeNull();
	});
});

describe('adaptTextMessage', () => {
	it('should adapt a text message context', () => {
		const ctx = createMockContext({
			message: {
				text: 'hello world',
				date: 1740000000, // Unix timestamp
				chat: { id: 12345, type: 'private' },
				message_id: 42,
				from: { id: 12345, is_bot: false, first_name: 'Test' },
			} as unknown as Context['message'],
		});

		const result = adaptTextMessage(ctx);

		expect(result).toEqual({
			userId: '12345',
			text: 'hello world',
			timestamp: new Date(1740000000 * 1000),
			chatId: 12345,
			messageId: 42,
		});
	});

	it('should return null when no text in message', () => {
		const ctx = createMockContext({
			message: {
				date: 1740000000,
				chat: { id: 12345, type: 'private' },
				message_id: 42,
			} as unknown as Context['message'],
		});

		expect(adaptTextMessage(ctx)).toBeNull();
	});

	it('should return null when no message', () => {
		const ctx = createMockContext();
		expect(adaptTextMessage(ctx)).toBeNull();
	});

	it('should return null when no user', () => {
		const ctx = createMockContext({
			from: undefined,
			message: {
				text: 'hello',
				date: 1740000000,
				chat: { id: 12345, type: 'private' },
				message_id: 42,
			} as unknown as Context['message'],
		});

		expect(adaptTextMessage(ctx)).toBeNull();
	});
});

describe('adaptPhotoMessage', () => {
	it('should adapt a photo message with caption', async () => {
		const mockFile = { file_id: 'abc', file_path: 'photos/file_0.jpg' };
		const mockPhotoBuffer = Buffer.from('fake-jpeg-data');

		// Mock global fetch
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			arrayBuffer: () =>
				Promise.resolve(
					mockPhotoBuffer.buffer.slice(
						mockPhotoBuffer.byteOffset,
						mockPhotoBuffer.byteOffset + mockPhotoBuffer.byteLength,
					),
				),
		});

		const ctx = createMockContext({
			message: {
				photo: [
					{ file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
					{ file_id: 'large', file_unique_id: 'l', width: 800, height: 600 },
				],
				caption: 'grocery receipt',
				date: 1740000000,
				chat: { id: 12345, type: 'private' },
				message_id: 99,
			} as unknown as Context['message'],
		});

		vi.mocked(ctx.api.getFile).mockResolvedValue(mockFile as never);

		const result = await adaptPhotoMessage(ctx);

		expect(result).toEqual({
			userId: '12345',
			photo: expect.any(Buffer),
			caption: 'grocery receipt',
			mimeType: 'image/jpeg',
			timestamp: new Date(1740000000 * 1000),
			chatId: 12345,
			messageId: 99,
		});

		// Should use the largest photo (last in array)
		expect(ctx.api.getFile).toHaveBeenCalledWith('large');

		globalThis.fetch = originalFetch;
	});

	it('should return null when no photo in message', async () => {
		const ctx = createMockContext({
			message: {
				date: 1740000000,
				chat: { id: 12345, type: 'private' },
				message_id: 42,
			} as unknown as Context['message'],
		});

		expect(await adaptPhotoMessage(ctx)).toBeNull();
	});

	it('should return null when photo array is empty', async () => {
		const ctx = createMockContext({
			message: {
				photo: [],
				date: 1740000000,
				chat: { id: 12345, type: 'private' },
				message_id: 42,
			} as unknown as Context['message'],
		});

		expect(await adaptPhotoMessage(ctx)).toBeNull();
	});

	it('should return null when fetch fails', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });

		const ctx = createMockContext({
			message: {
				photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 100, height: 100 }],
				date: 1740000000,
				chat: { id: 12345, type: 'private' },
				message_id: 42,
			} as unknown as Context['message'],
		});

		vi.mocked(ctx.api.getFile).mockResolvedValue({ file_id: 'f1', file_path: 'p.jpg' } as never);

		expect(await adaptPhotoMessage(ctx)).toBeNull();

		globalThis.fetch = originalFetch;
	});
});
