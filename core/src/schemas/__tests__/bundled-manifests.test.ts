import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ManifestDataScope } from '../../types/manifest.js';
import { readYamlFile } from '../../utils/yaml.js';
import { warnScopePathPrefix } from '../../services/data-store/paths.js';
import { validateManifest } from '../validate-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appsDir = join(__dirname, '..', '..', '..', '..', 'apps');

describe('bundled manifests', () => {
	it('validate and avoid app-prefixed scope paths', async () => {
		const entries = await readdir(appsDir, { withFileTypes: true });
		const appDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

		expect(appDirs.length).toBeGreaterThan(0);

		for (const appName of appDirs) {
			const manifestPath = join(appsDir, appName, 'manifest.yaml');
			const manifestData = await readYamlFile(manifestPath);

			expect(manifestData, `missing manifest for ${appName}`).not.toBeNull();

			const validation = validateManifest(manifestData);
			expect(validation.valid, `invalid manifest for ${appName}`).toBe(true);
			if (!validation.valid) continue;

			const manifest = validation.manifest;
			const warnings = [
				...warnScopePathPrefix(
					manifest.app.id,
					manifest.requirements?.data?.user_scopes ?? ([] as ManifestDataScope[]),
				),
				...warnScopePathPrefix(
					manifest.app.id,
					manifest.requirements?.data?.shared_scopes ?? ([] as ManifestDataScope[]),
				),
			];

			expect(warnings, `scope warnings for ${manifest.app.id}`).toEqual([]);
		}
	});
});
