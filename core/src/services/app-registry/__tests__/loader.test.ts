import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLoader } from '../loader.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

const validManifestYaml = `
app:
  id: test-app
  name: "Test App"
  version: "1.0.0"
  description: "A test app."
  author: "Test Author"

capabilities:
  messages:
    intents:
      - "test"
    commands:
      - name: /test
        description: "Test command"

requirements:
  services:
    - telegram
`;

const invalidManifestYaml = `
app:
  id: bad-app
  # missing required fields
`;

async function writeRuntimeModule(path: string, marker: string): Promise<void> {
	await writeFile(
		path,
		`
			export default {
				runtimeMarker: ${JSON.stringify(marker)},
				async init() {},
				async handleMessage() {},
			};
		`,
	);
}

async function writeCommonJsRuntimeModule(path: string, marker: string): Promise<void> {
	await writeFile(
		path,
		`
			module.exports = {
				runtimeMarker: ${JSON.stringify(marker)},
				async init() {},
				async handleMessage() {},
			};
		`,
	);
}

describe('AppLoader', () => {
	let tempDir: string;
	let logger: Logger;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-loader-'));
		logger = createMockLogger();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('discoverApps', () => {
		it('should find directories with manifest.yaml', async () => {
			const app1Dir = join(tempDir, 'app1');
			const app2Dir = join(tempDir, 'app2');
			await mkdir(app1Dir, { recursive: true });
			await mkdir(app2Dir, { recursive: true });
			await writeFile(join(app1Dir, 'manifest.yaml'), validManifestYaml);
			await writeFile(join(app2Dir, 'manifest.yaml'), validManifestYaml);
			await mkdir(join(tempDir, 'no-manifest'), { recursive: true });
			await writeFile(join(tempDir, 'not-a-dir.txt'), 'hello');

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const dirs = await loader.discoverApps();

			expect(dirs).toHaveLength(2);
			expect(dirs).toContain(app1Dir);
			expect(dirs).toContain(app2Dir);
		});

		it('should return empty array when appsDir does not exist', async () => {
			const loader = new AppLoader({ appsDir: join(tempDir, 'nonexistent'), logger });
			const dirs = await loader.discoverApps();

			expect(dirs).toHaveLength(0);
			expect(logger.warn).toHaveBeenCalled();
		});

		it('should return empty array when no apps have manifests', async () => {
			await mkdir(join(tempDir, 'empty-app'), { recursive: true });

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const dirs = await loader.discoverApps();

			expect(dirs).toHaveLength(0);
		});
	});

	describe('loadManifest', () => {
		it('should load and validate a valid manifest', async () => {
			const appDir = join(tempDir, 'valid-app');
			await mkdir(appDir, { recursive: true });
			await writeFile(join(appDir, 'manifest.yaml'), validManifestYaml);

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const manifest = await loader.loadManifest(appDir);

			expect(manifest).not.toBeNull();
			expect(manifest?.app.id).toBe('test-app');
			expect(manifest?.app.name).toBe('Test App');
			expect(manifest?.capabilities?.messages?.intents).toEqual(['test']);
		});

		it('should return null for invalid manifest', async () => {
			const appDir = join(tempDir, 'invalid-app');
			await mkdir(appDir, { recursive: true });
			await writeFile(join(appDir, 'manifest.yaml'), invalidManifestYaml);

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const manifest = await loader.loadManifest(appDir);

			expect(manifest).toBeNull();
			expect(logger.error).toHaveBeenCalled();
		});

		it('should return null when manifest.yaml is missing', async () => {
			const appDir = join(tempDir, 'no-manifest');
			await mkdir(appDir, { recursive: true });

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const manifest = await loader.loadManifest(appDir);

			expect(manifest).toBeNull();
		});
	});

	describe('importModule', () => {
		it('imports a safe package.json main entry before dev fallbacks', async () => {
			const appDir = join(tempDir, 'main-app');
			await mkdir(join(appDir, 'dist'), { recursive: true });
			await mkdir(join(appDir, 'src'), { recursive: true });
			await writeFile(join(appDir, 'package.json'), JSON.stringify({ main: 'dist/runtime.js' }));
			await writeRuntimeModule(join(appDir, 'dist', 'runtime.js'), 'package-main');
			await writeFile(join(appDir, 'src', 'index.ts'), 'this is not valid ts');

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).not.toBeNull();
			expect((module as Record<string, unknown>).runtimeMarker).toBe('package-main');
		});

		it('falls back to dist/index.js when package.json main is missing', async () => {
			const appDir = join(tempDir, 'dist-app');
			await mkdir(join(appDir, 'dist'), { recursive: true });
			await writeRuntimeModule(join(appDir, 'dist', 'index.js'), 'dist-index');

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).not.toBeNull();
			expect((module as Record<string, unknown>).runtimeMarker).toBe('dist-index');
		});

		it('accepts package.json main entries pointing to dist/index.mjs', async () => {
			const appDir = join(tempDir, 'mjs-app');
			await mkdir(join(appDir, 'dist'), { recursive: true });
			await writeFile(join(appDir, 'package.json'), JSON.stringify({ main: 'dist/index.mjs' }));
			await writeRuntimeModule(join(appDir, 'dist', 'index.mjs'), 'dist-mjs');

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).not.toBeNull();
			expect((module as Record<string, unknown>).runtimeMarker).toBe('dist-mjs');
		});

		it('accepts package.json main entries pointing to dist/index.cjs', async () => {
			const appDir = join(tempDir, 'cjs-app');
			await mkdir(join(appDir, 'dist'), { recursive: true });
			await writeFile(join(appDir, 'package.json'), JSON.stringify({ main: 'dist/index.cjs' }));
			await writeCommonJsRuntimeModule(join(appDir, 'dist', 'index.cjs'), 'dist-cjs');

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).not.toBeNull();
			expect((module as Record<string, unknown>).runtimeMarker).toBe('dist-cjs');
		});

		it('ignores package.json main traversal attempts and falls back safely', async () => {
			const appDir = join(tempDir, 'traversal-app');
			await mkdir(join(appDir, 'dist'), { recursive: true });
			await writeFile(join(appDir, 'package.json'), JSON.stringify({ main: '../../etc/passwd' }));
			await writeRuntimeModule(join(appDir, 'dist', 'index.js'), 'dist-fallback');

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).not.toBeNull();
			expect((module as Record<string, unknown>).runtimeMarker).toBe('dist-fallback');
			expect(logger.debug).toHaveBeenCalled();
		});

		it('ignores absolute package.json main paths and falls back safely', async () => {
			const appDir = join(tempDir, 'absolute-app');
			await mkdir(join(appDir, 'dist'), { recursive: true });
			await writeFile(join(appDir, 'package.json'), JSON.stringify({ main: 'C:/absolute/path.js' }));
			await writeRuntimeModule(join(appDir, 'dist', 'index.js'), 'dist-fallback');

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).not.toBeNull();
			expect((module as Record<string, unknown>).runtimeMarker).toBe('dist-fallback');
		});

		it('ignores unsupported package.json main extensions and keeps the fallback chain alive', async () => {
			const appDir = join(tempDir, 'bad-ext-app');
			await mkdir(join(appDir, 'dist'), { recursive: true });
			await writeFile(join(appDir, 'package.json'), JSON.stringify({ main: 'dist/index.ts' }));
			await writeRuntimeModule(join(appDir, 'dist', 'index.js'), 'dist-fallback');

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).not.toBeNull();
			expect((module as Record<string, unknown>).runtimeMarker).toBe('dist-fallback');
		});

		it('skips malformed compiled candidates and keeps dev fallbacks alive', async () => {
			const appDir = join(tempDir, 'malformed-dist-app');
			await mkdir(join(appDir, 'dist'), { recursive: true });
			await mkdir(join(appDir, 'src'), { recursive: true });
			await writeFile(join(appDir, 'dist', 'index.js'), 'export default { runtimeMarker: "broken-dist" };');
			await writeRuntimeModule(join(appDir, 'src', 'index.ts'), 'dev-fallback');

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).not.toBeNull();
			expect((module as Record<string, unknown>).runtimeMarker).toBe('dev-fallback');
			expect(logger.warn).toHaveBeenCalled();
		});

		it('returns null when no module file exists', async () => {
			const appDir = join(tempDir, 'empty-app');
			await mkdir(appDir, { recursive: true });

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).toBeNull();
			expect(logger.error).toHaveBeenCalled();
		});
	});
});
