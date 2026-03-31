import { describe, expect, it } from 'vitest';
import type { AppManifest } from '../../../types/manifest.js';
import { ManifestCache } from '../manifest-cache.js';

function makeManifest(overrides: Partial<AppManifest> & { app: AppManifest['app'] }): AppManifest {
	return {
		capabilities: undefined,
		requirements: undefined,
		...overrides,
	};
}

const echoManifest = makeManifest({
	app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Echo app', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['echo', 'repeat'],
			commands: [{ name: '/echo', description: 'Echo a message', args: ['message'] }],
		},
	},
});

const groceryManifest = makeManifest({
	app: {
		id: 'grocery',
		name: 'Grocery',
		version: '1.0.0',
		description: 'Grocery app',
		author: 'Test',
	},
	capabilities: {
		messages: {
			intents: ['add grocery', 'grocery list', 'shopping'],
			commands: [
				{ name: '/grocery', description: 'Manage grocery list' },
				{ name: '/add', description: 'Add item', args: ['item'] },
			],
			accepts_photos: true,
			photo_intents: ['receipt', 'grocery photo'],
		},
	},
});

const photoManifest = makeManifest({
	app: {
		id: 'photos',
		name: 'Photos',
		version: '1.0.0',
		description: 'Photo storage',
		author: 'Test',
	},
	capabilities: {
		messages: {
			accepts_photos: true,
			photo_intents: ['landscape', 'document'],
		},
	},
});

describe('ManifestCache', () => {
	describe('add / get / has / size', () => {
		it('should store and retrieve manifests', () => {
			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');

			expect(cache.has('echo')).toBe(true);
			expect(cache.has('nonexistent')).toBe(false);
			expect(cache.get('echo')).toEqual({ manifest: echoManifest, appDir: '/apps/echo' });
			expect(cache.get('nonexistent')).toBeUndefined();
			expect(cache.size).toBe(1);
		});

		it('should return all entries', () => {
			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			cache.add(groceryManifest, '/apps/grocery');

			const all = cache.getAll();
			expect(all).toHaveLength(2);
			expect(all.map((e) => e.manifest.app.id).sort()).toEqual(['echo', 'grocery']);
		});
	});

	describe('buildCommandMap', () => {
		it('should build O(1) command map from all manifests', () => {
			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			cache.add(groceryManifest, '/apps/grocery');

			const map = cache.buildCommandMap();

			expect(map.size).toBe(3);
			expect(map.get('/echo')).toEqual({
				appId: 'echo',
				command: { name: '/echo', description: 'Echo a message', args: ['message'] },
			});
			expect(map.get('/grocery')).toEqual({
				appId: 'grocery',
				command: { name: '/grocery', description: 'Manage grocery list' },
			});
			expect(map.get('/add')).toEqual({
				appId: 'grocery',
				command: { name: '/add', description: 'Add item', args: ['item'] },
			});
		});

		it('should skip duplicate commands and keep the first', () => {
			const duplicateManifest = makeManifest({
				app: { id: 'other', name: 'Other', version: '1.0.0', description: 'Other', author: 'Test' },
				capabilities: {
					messages: {
						commands: [{ name: '/echo', description: 'Duplicate echo' }],
					},
				},
			});

			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			cache.add(duplicateManifest, '/apps/other');

			const map = cache.buildCommandMap();
			expect(map.get('/echo')?.appId).toBe('echo');
		});

		it('should return empty map when no commands are declared', () => {
			const noCommandsManifest = makeManifest({
				app: {
					id: 'bare',
					name: 'Bare',
					version: '1.0.0',
					description: 'No commands',
					author: 'Test',
				},
			});

			const cache = new ManifestCache();
			cache.add(noCommandsManifest, '/apps/bare');

			expect(cache.buildCommandMap().size).toBe(0);
		});
	});

	describe('buildIntentTable', () => {
		it('should collect all intents from all manifests', () => {
			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			cache.add(groceryManifest, '/apps/grocery');

			const table = cache.buildIntentTable();

			expect(table).toHaveLength(5);
			expect(table).toContainEqual({ category: 'echo', appId: 'echo' });
			expect(table).toContainEqual({ category: 'repeat', appId: 'echo' });
			expect(table).toContainEqual({ category: 'add grocery', appId: 'grocery' });
			expect(table).toContainEqual({ category: 'grocery list', appId: 'grocery' });
			expect(table).toContainEqual({ category: 'shopping', appId: 'grocery' });
		});

		it('should return empty table when no intents are declared', () => {
			const cache = new ManifestCache();
			cache.add(photoManifest, '/apps/photos');

			expect(cache.buildIntentTable()).toHaveLength(0);
		});
	});

	describe('buildPhotoIntentTable', () => {
		it('should collect photo intents only from apps that accept photos', () => {
			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			cache.add(groceryManifest, '/apps/grocery');
			cache.add(photoManifest, '/apps/photos');

			const table = cache.buildPhotoIntentTable();

			expect(table).toHaveLength(4);
			expect(table).toContainEqual({ category: 'receipt', appId: 'grocery' });
			expect(table).toContainEqual({ category: 'grocery photo', appId: 'grocery' });
			expect(table).toContainEqual({ category: 'landscape', appId: 'photos' });
			expect(table).toContainEqual({ category: 'document', appId: 'photos' });
		});

		it('should not include intents from apps without accepts_photos', () => {
			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');

			expect(cache.buildPhotoIntentTable()).toHaveLength(0);
		});
	});

	describe('getPhotoAppIds', () => {
		it('should return IDs of apps that accept photos', () => {
			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			cache.add(groceryManifest, '/apps/grocery');
			cache.add(photoManifest, '/apps/photos');

			const ids = cache.getPhotoAppIds();
			expect(ids.sort()).toEqual(['grocery', 'photos']);
		});

		it('should return empty array when no apps accept photos', () => {
			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');

			expect(cache.getPhotoAppIds()).toHaveLength(0);
		});
	});
});
