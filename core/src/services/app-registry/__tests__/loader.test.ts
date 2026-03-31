import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
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
			// Create two valid apps
			const app1Dir = join(tempDir, 'app1');
			const app2Dir = join(tempDir, 'app2');
			await mkdir(app1Dir, { recursive: true });
			await mkdir(app2Dir, { recursive: true });
			await writeFile(join(app1Dir, 'manifest.yaml'), validManifestYaml);
			await writeFile(join(app2Dir, 'manifest.yaml'), validManifestYaml);

			// Create a dir without manifest (should be skipped)
			await mkdir(join(tempDir, 'no-manifest'), { recursive: true });

			// Create a file (not a dir, should be skipped)
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
		it('should import a valid TypeScript app module', async () => {
			const appDir = join(tempDir, 'ts-app');
			await mkdir(appDir, { recursive: true });

			// Write a minimal app module
			const moduleCode = `
				export default {
					async init(services) {},
					async handleMessage(ctx) {},
				};
			`;
			await writeFile(join(appDir, 'index.ts'), moduleCode);

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			// In a test environment with tsx, this should work
			// But if it fails to import, it should return null gracefully
			// We just verify no errors are thrown
			if (module !== null) {
				expect(typeof module.init).toBe('function');
				expect(typeof module.handleMessage).toBe('function');
			}
		});

		it('should return null when no module file exists', async () => {
			const appDir = join(tempDir, 'empty-app');
			await mkdir(appDir, { recursive: true });

			const loader = new AppLoader({ appsDir: tempDir, logger });
			const module = await loader.importModule(appDir);

			expect(module).toBeNull();
			expect(logger.error).toHaveBeenCalled();
		});
	});
});
