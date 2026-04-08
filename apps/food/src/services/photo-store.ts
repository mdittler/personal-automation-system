/**
 * Photo storage helpers for the Food app.
 *
 * Stores photos as base64-encoded strings via the existing ScopedDataStore.
 * This avoids needing binary support in the data store infrastructure.
 */

import { createHash } from 'node:crypto';
import type { ScopedDataStore } from '@pas/core/types';

export type PhotoCategory = 'recipe' | 'receipt' | 'pantry';

/**
 * Save a photo to the shared data store.
 * Returns the storage path (relative to the store root).
 */
export async function savePhoto(
	store: ScopedDataStore,
	photo: Buffer,
	category: PhotoCategory,
): Promise<string> {
	const date = new Date().toISOString().slice(0, 10);
	const hash = createHash('md5').update(photo).digest('hex').slice(0, 8);
	const path = `photos/${category}-${date}-${hash}.b64`;
	await store.write(path, photo.toString('base64'));
	return path;
}

/**
 * Load a photo from the shared data store.
 * Returns the photo as a Buffer, or null if not found.
 */
export async function loadPhoto(
	store: ScopedDataStore,
	path: string,
): Promise<Buffer | null> {
	const content = await store.read(path);
	if (!content) return null;
	return Buffer.from(content, 'base64');
}
