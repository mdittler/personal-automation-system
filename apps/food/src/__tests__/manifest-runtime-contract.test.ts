import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateManifest } from '../../../../core/src/schemas/validate-manifest.js';
import { ChangeLog } from '../../../../core/src/services/data-store/change-log.js';
import { DataStoreServiceImpl } from '../../../../core/src/services/data-store/index.js';
import { warnScopePathPrefix } from '../../../../core/src/services/data-store/paths.js';
import type { AppManifest } from '../../../../core/src/types/manifest.js';
import { readYamlFile } from '../../../../core/src/utils/yaml.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(__dirname, '..', '..', 'manifest.yaml');

async function loadFoodManifest(): Promise<AppManifest> {
	const manifestData = await readYamlFile(manifestPath);
	const validation = validateManifest(manifestData);
	if (!validation.valid) {
		throw new Error(`Invalid food manifest: ${validation.errors.join('; ')}`);
	}
	return validation.manifest;
}

function createStoreService(dataDir: string, manifest: AppManifest): DataStoreServiceImpl {
	return new DataStoreServiceImpl({
		dataDir,
		appId: manifest.app.id,
		userScopes: manifest.requirements?.data?.user_scopes ?? [],
		sharedScopes: manifest.requirements?.data?.shared_scopes ?? [],
		changeLog: new ChangeLog(dataDir),
	});
}

describe('food manifest/runtime contract', () => {
	let tempDir: string;
	let dataDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-food-manifest-contract-'));
		dataDir = join(tempDir, 'data');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('declares root-relative scopes with no app-prefixed warnings', async () => {
		const manifest = await loadFoodManifest();
		const scopes = [
			...(manifest.requirements?.data?.shared_scopes ?? []),
			...(manifest.requirements?.data?.user_scopes ?? []),
		];

		expect(warnScopePathPrefix(manifest.app.id, scopes)).toEqual([]);
	});

	it('accepts representative shared and user paths under the current manifest contract', async () => {
		const manifest = await loadFoodManifest();
		const service = createStoreService(dataDir, manifest);
		const sharedStore = service.forShared('shared');
		const userStore = service.forUser('user-1');

		// Known limitation: `forShared(scope)` still ignores its selector argument.
		// This test pins app-relative shared-scope compatibility only; selector
		// semantics remain separately tracked in docs/open-items.md.
		await expect(sharedStore.write('recipes/test.yaml', 'recipe')).resolves.toBeUndefined();
		await expect(sharedStore.read('recipes/test.yaml')).resolves.toBe('recipe');
		await expect(sharedStore.write('grocery/active.yaml', 'grocery')).resolves.toBeUndefined();
		await expect(sharedStore.read('grocery/active.yaml')).resolves.toBe('grocery');
		await expect(sharedStore.write('receipts/test.yaml', 'receipt')).resolves.toBeUndefined();
		await expect(sharedStore.read('receipts/test.yaml')).resolves.toBe('receipt');

		await expect(userStore.write('preferences.yaml', 'prefs')).resolves.toBeUndefined();
		await expect(userStore.read('preferences.yaml')).resolves.toBe('prefs');
		await expect(userStore.write('shopping-sessions/test.yaml', 'session')).resolves.toBeUndefined();
		await expect(userStore.read('shopping-sessions/test.yaml')).resolves.toBe('session');
	});

	it('rejects legacy app-prefixed, traversal, and cross-scope misuse paths', async () => {
		const manifest = await loadFoodManifest();
		const service = createStoreService(dataDir, manifest);
		const sharedStore = service.forShared('shared');
		const userStore = service.forUser('user-1');

		await expect(sharedStore.write('food/recipes/test.yaml', 'legacy')).rejects.toThrow();
		await expect(sharedStore.write('../recipes/test.yaml', 'traversal')).rejects.toThrow();
		await expect(userStore.write('recipes/test.yaml', 'wrong-scope')).rejects.toThrow();
		await expect(sharedStore.write('preferences.yaml', 'wrong-scope')).rejects.toThrow();
	});
});
