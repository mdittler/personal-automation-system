import { describe, expect, it, vi } from 'vitest';
import { loadPhoto, savePhoto } from '../services/photo-store.js';

function createMockStore() {
	const storage = new Map<string, string>();
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => {
			storage.set(path, content);
		}),
		list: vi.fn(),
		exists: vi.fn(),
		delete: vi.fn(),
	};
}

describe('PhotoStore', () => {
	describe('savePhoto', () => {
		it('saves photo as base64 and returns path', async () => {
			const store = createMockStore();
			const photo = Buffer.from('fake-jpeg-data');

			const path = await savePhoto(store as never, photo, 'recipe');

			expect(path).toMatch(/^photos\/recipe-\d{4}-\d{2}-\d{2}-[a-f0-9]+\.b64$/);
			expect(store.write).toHaveBeenCalledWith(
				path,
				photo.toString('base64'),
			);
		});

		it('generates different filenames for different categories', async () => {
			const store = createMockStore();
			const photo = Buffer.from('data');

			const recipePath = await savePhoto(store as never, photo, 'recipe');
			const receiptPath = await savePhoto(store as never, photo, 'receipt');
			const pantryPath = await savePhoto(store as never, photo, 'pantry');

			expect(recipePath).toContain('recipe-');
			expect(receiptPath).toContain('receipt-');
			expect(pantryPath).toContain('pantry-');
		});
	});

	describe('loadPhoto', () => {
		it('loads base64 and returns Buffer', async () => {
			const store = createMockStore();
			const original = Buffer.from('test-image-data');
			const path = await savePhoto(store as never, original, 'recipe');

			const loaded = await loadPhoto(store as never, path);

			expect(loaded).toBeInstanceOf(Buffer);
			expect(loaded?.toString()).toBe('test-image-data');
		});

		it('returns null for missing file', async () => {
			const store = createMockStore();

			const loaded = await loadPhoto(store as never, 'photos/nonexistent.b64');

			expect(loaded).toBeNull();
		});
	});
});
