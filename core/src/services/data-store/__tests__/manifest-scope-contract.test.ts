import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateManifest } from '../../../schemas/validate-manifest.js';
import type { AppManifest } from '../../../types/manifest.js';
import { readYamlFile } from '../../../utils/yaml.js';
import { ChangeLog } from '../change-log.js';
import { DataStoreServiceImpl } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appsDir = join(__dirname, '..', '..', '..', '..', '..', 'apps');
// Arbitrary fixed date: these tests verify scope/path enforcement, not wall-clock behavior.
const FIXED_DATE_PATH = 'daily-notes/2026-01-02.md';

async function loadBundledManifest(appId: string): Promise<AppManifest> {
	const manifestPath = join(appsDir, appId, 'manifest.yaml');
	const manifestData = await readYamlFile(manifestPath);
	const validation = validateManifest(manifestData);
	if (!validation.valid) {
		throw new Error(`Invalid bundled manifest for ${appId}: ${validation.errors.join('; ')}`);
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

describe('bundled manifest scope contract', () => {
	let tempDir: string;
	let dataDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-manifest-scope-'));
		dataDir = join(tempDir, 'data');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('echo accepts log.md and rejects traversal outside its declared scope', async () => {
		const manifest = await loadBundledManifest('echo');
		const store = createStoreService(dataDir, manifest).forUser('user-1');

		await expect(store.write('log.md', 'hello')).resolves.toBeUndefined();
		await expect(store.read('log.md')).resolves.toBe('hello');
		await expect(store.write('../other-app/secret.md', 'nope')).rejects.toThrow();
	});

	it('notes accepts daily notes and rejects traversal outside its declared scope', async () => {
		const manifest = await loadBundledManifest('notes');
		const store = createStoreService(dataDir, manifest).forUser('user-1');

		await expect(store.write(FIXED_DATE_PATH, 'note')).resolves.toBeUndefined();
		await expect(store.read(FIXED_DATE_PATH)).resolves.toBe('note');
		await expect(store.write('../../system/config.yaml', 'nope')).rejects.toThrow();
	});

	it('chatbot accepts history.json and daily notes and rejects unrelated app paths', async () => {
		const manifest = await loadBundledManifest('chatbot');
		const store = createStoreService(dataDir, manifest).forUser('user-1');

		await expect(store.write('history.json', '{"messages":[]}')).resolves.toBeUndefined();
		await expect(store.read('history.json')).resolves.toBe('{"messages":[]}');
		await expect(store.write(FIXED_DATE_PATH, 'daily note')).resolves.toBeUndefined();
		await expect(store.read(FIXED_DATE_PATH)).resolves.toBe('daily note');
		await expect(store.write('../food/recipes/secret.md', 'nope')).rejects.toThrow();
	});
});
