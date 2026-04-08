import { describe, expect, it } from 'vitest';
import type { MessageContext, PhotoContext } from '../../../types/telegram.js';
import { PendingVerificationStore } from '../pending-verification-store.js';

function makeMessageCtx(): MessageContext {
	return {
		userId: '123',
		text: 'hello',
		timestamp: new Date(),
		chatId: 1001,
		messageId: 42,
	};
}

function makePhotoCtx(): PhotoContext {
	return {
		userId: '123',
		photo: Buffer.from('fake'),
		mimeType: 'image/jpeg',
		timestamp: new Date(),
		chatId: 1001,
		messageId: 43,
	};
}

const baseInput = {
	ctx: makeMessageCtx(),
	isPhoto: false,
	classifierResult: { appId: 'food', intent: 'log-meal', confidence: 0.72 },
	verifierSuggestedAppId: 'notes',
	sentMessageId: 999,
	sentChatId: 1001,
};

describe('PendingVerificationStore', () => {
	it('adds and retrieves a pending entry', () => {
		const store = new PendingVerificationStore();
		const id = store.add(baseInput);

		const entry = store.get(id);
		expect(entry).toBeDefined();
		const e = entry as NonNullable<typeof entry>;
		expect(e.classifierResult.appId).toBe('food');
		expect(e.verifierSuggestedAppId).toBe('notes');
		expect(e.sentMessageId).toBe(999);
		expect(e.sentChatId).toBe(1001);
		expect(e.isPhoto).toBe(false);
		expect(e.createdAt).toBeInstanceOf(Date);
	});

	it('get does not remove the entry', () => {
		const store = new PendingVerificationStore();
		const id = store.add(baseInput);

		store.get(id);
		expect(store.get(id)).toBeDefined();
		expect(store.size).toBe(1);
	});

	it('returns undefined for unknown IDs', () => {
		const store = new PendingVerificationStore();
		expect(store.get('nonexistent')).toBeUndefined();
	});

	it('resolve removes and returns the entry', () => {
		const store = new PendingVerificationStore();
		const id = store.add(baseInput);

		const entry = store.resolve(id);
		expect(entry).toBeDefined();
		expect((entry as NonNullable<typeof entry>).classifierResult.intent).toBe('log-meal');
		expect(store.size).toBe(0);
	});

	it('double resolve returns undefined on second call', () => {
		const store = new PendingVerificationStore();
		const id = store.add(baseInput);

		store.resolve(id);
		expect(store.resolve(id)).toBeUndefined();
	});

	it('resolve returns undefined for unknown IDs', () => {
		const store = new PendingVerificationStore();
		expect(store.resolve('nope')).toBeUndefined();
	});

	it('size reflects current number of pending entries', () => {
		const store = new PendingVerificationStore();
		expect(store.size).toBe(0);

		const id1 = store.add(baseInput);
		const id2 = store.add({ ...baseInput, ctx: makePhotoCtx(), isPhoto: true });
		expect(store.size).toBe(2);

		store.resolve(id1);
		expect(store.size).toBe(1);

		store.resolve(id2);
		expect(store.size).toBe(0);
	});

	it('stores optional photoPath field', () => {
		const store = new PendingVerificationStore();
		const id = store.add({ ...baseInput, photoPath: '/tmp/photo.jpg' });

		const entry = store.get(id);
		expect((entry as NonNullable<typeof entry>).photoPath).toBe('/tmp/photo.jpg');
	});

	it('generated IDs fit in Telegram callback data budget', () => {
		const store = new PendingVerificationStore();
		// callback format: rv:<pendingId>:<appId>
		// appId can be up to ~20 chars, pendingId is 12 hex chars
		// budget: 64 bytes total
		const longAppId = 'a'.repeat(20);
		const id = store.add({ ...baseInput, verifierSuggestedAppId: longAppId });

		const callbackData = `rv:${id}:${longAppId}`;
		expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThan(64);
	});

	it('each add generates a unique ID', () => {
		const store = new PendingVerificationStore();
		const ids = new Set<string>();
		for (let i = 0; i < 20; i++) {
			ids.add(store.add(baseInput));
		}
		expect(ids.size).toBe(20);
	});
});
