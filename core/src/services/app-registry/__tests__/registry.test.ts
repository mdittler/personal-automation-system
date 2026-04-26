import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreServices } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import { AppRegistry, type ServiceFactory } from '../index.js';

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

function createMockConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp/data',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test-token' },
		ollama: { url: 'http://localhost:11434', model: 'llama3.2:3b' },
		claude: { apiKey: 'test-key', model: 'claude-sonnet-4-20250514' },
		gui: { authToken: 'test-auth' },
		cloudflare: {},
		users: [],
	};
}

function createMockServiceFactory(): ServiceFactory {
	return vi.fn().mockReturnValue({} as CoreServices);
}

const validManifestYaml = `
app:
  id: echo
  name: "Echo"
  version: "1.0.0"
  description: "Echo app for testing."
  author: "Test"

capabilities:
  messages:
    intents:
      - "echo"
    commands:
      - name: /echo
        description: "Echo a message"
        args:
          - message

requirements:
  services:
    - telegram
`;

describe('AppRegistry', () => {
	let tempDir: string;
	let logger: Logger;
	let config: SystemConfig;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-registry-'));
		logger = createMockLogger();
		config = createMockConfig();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('should load a valid app and register it', async () => {
		// Create app directory with manifest and module
		const appDir = join(tempDir, 'echo');
		await mkdir(appDir, { recursive: true });
		await writeFile(join(appDir, 'manifest.yaml'), validManifestYaml);
		await writeFile(
			join(appDir, 'index.ts'),
			`
			export default {
				async init(services) {},
				async handleMessage(ctx) {},
			};
		`,
		);

		const registry = new AppRegistry({ appsDir: tempDir, config, logger });
		const serviceFactory = createMockServiceFactory();

		await registry.loadAll(serviceFactory);

		expect(registry.getLoadedAppIds()).toContain('echo');
		expect(registry.getApp('echo')).toBeDefined();
		expect(registry.getApp('echo')?.manifest.app.id).toBe('echo');
		expect(serviceFactory).toHaveBeenCalledOnce();
	});

	it('should skip apps with invalid manifests', async () => {
		const appDir = join(tempDir, 'bad-app');
		await mkdir(appDir, { recursive: true });
		await writeFile(join(appDir, 'manifest.yaml'), 'app:\n  id: bad\n');

		const registry = new AppRegistry({ appsDir: tempDir, config, logger });
		await registry.loadAll(createMockServiceFactory());

		expect(registry.getLoadedAppIds()).toHaveLength(0);
	});

	it('should skip apps whose init() throws', async () => {
		const appDir = join(tempDir, 'failing');
		await mkdir(appDir, { recursive: true });
		await writeFile(join(appDir, 'manifest.yaml'), validManifestYaml.replace('echo', 'failing'));
		await writeFile(
			join(appDir, 'index.ts'),
			`
			export default {
				async init() { throw new Error('init failed'); },
				async handleMessage() {},
			};
		`,
		);

		const registry = new AppRegistry({ appsDir: tempDir, config, logger });
		await registry.loadAll(createMockServiceFactory());

		expect(registry.getApp('failing')).toBeUndefined();
		expect(logger.error).toHaveBeenCalled();
	});

	it('should return manifest cache with loaded manifests', async () => {
		const appDir = join(tempDir, 'echo');
		await mkdir(appDir, { recursive: true });
		await writeFile(join(appDir, 'manifest.yaml'), validManifestYaml);
		await writeFile(
			join(appDir, 'index.ts'),
			`
			export default {
				async init() {},
				async handleMessage() {},
			};
		`,
		);

		const registry = new AppRegistry({ appsDir: tempDir, config, logger });
		await registry.loadAll(createMockServiceFactory());

		const cache = registry.getManifestCache();
		expect(cache.has('echo')).toBe(true);
		const commandMap = cache.buildCommandMap();
		expect(commandMap.has('/echo')).toBe(true);
	});

	it('should call shutdown on all loaded apps', async () => {
		const shutdownCalled: string[] = [];

		// Create a single app
		const appDir = join(tempDir, 'echo');
		await mkdir(appDir, { recursive: true });
		await writeFile(join(appDir, 'manifest.yaml'), validManifestYaml);
		await writeFile(
			join(appDir, 'index.ts'),
			`
			export default {
				async init() {},
				async handleMessage() {},
				async shutdown() {},
			};
		`,
		);

		const registry = new AppRegistry({ appsDir: tempDir, config, logger });
		await registry.loadAll(createMockServiceFactory());

		// Patch shutdown to track
		const app = registry.getApp('echo');
		expect(app).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: validated by expect above
		app!.module.shutdown = async () => {
			shutdownCalled.push('echo');
		};

		await registry.shutdownAll();

		expect(shutdownCalled).toEqual(['echo']);
	});

	it('should not crash if shutdown throws', async () => {
		const appDir = join(tempDir, 'echo');
		await mkdir(appDir, { recursive: true });
		await writeFile(join(appDir, 'manifest.yaml'), validManifestYaml);
		await writeFile(
			join(appDir, 'index.ts'),
			`
			export default {
				async init() {},
				async handleMessage() {},
				async shutdown() {},
			};
		`,
		);

		const registry = new AppRegistry({ appsDir: tempDir, config, logger });
		await registry.loadAll(createMockServiceFactory());

		const app = registry.getApp('echo');
		// biome-ignore lint/style/noNonNullAssertion: validated by loadAll succeeding
		app!.module.shutdown = async () => {
			throw new Error('shutdown boom');
		};

		// Should not throw
		await registry.shutdownAll();
		expect(logger.error).toHaveBeenCalled();
	});

	it('should handle empty apps directory gracefully', async () => {
		const registry = new AppRegistry({
			appsDir: join(tempDir, 'nonexistent'),
			config,
			logger,
		});

		await registry.loadAll(createMockServiceFactory());

		expect(registry.getLoadedAppIds()).toHaveLength(0);
	});

	it('should shutdown gracefully with no loaded apps', async () => {
		const registry = new AppRegistry({
			appsDir: join(tempDir, 'nonexistent'),
			config,
			logger,
		});

		await registry.loadAll(createMockServiceFactory());

		// Should not throw with zero apps loaded
		await registry.shutdownAll();

		expect(registry.getLoadedAppIds()).toHaveLength(0);
	});

	it('should return undefined for unknown app ID', async () => {
		const registry = new AppRegistry({ appsDir: tempDir, config, logger });
		await registry.loadAll(createMockServiceFactory());

		expect(registry.getApp('nonexistent-app')).toBeUndefined();
	});

	it('should reject duplicate app IDs: only the first app is loaded and logger.error is called', async () => {
		// Create two app directories that both declare app.id = "echo"
		const appDir1 = join(tempDir, 'echo-first');
		await mkdir(appDir1, { recursive: true });
		await writeFile(join(appDir1, 'manifest.yaml'), validManifestYaml);
		await writeFile(
			join(appDir1, 'index.ts'),
			`export default { async init() {}, async handleMessage() {} };`,
		);

		const appDir2 = join(tempDir, 'echo-second');
		await mkdir(appDir2, { recursive: true });
		// Same app.id ("echo") as the first directory
		await writeFile(join(appDir2, 'manifest.yaml'), validManifestYaml);
		await writeFile(
			join(appDir2, 'index.ts'),
			`export default { async init() {}, async handleMessage() {} };`,
		);

		const registry = new AppRegistry({ appsDir: tempDir, config, logger });
		const serviceFactory = createMockServiceFactory();
		await registry.loadAll(serviceFactory);

		// Only one app should be registered
		expect(registry.getLoadedAppIds()).toHaveLength(1);
		expect(registry.getLoadedAppIds()).toContain('echo');

		// The service factory should only have been called once (duplicate never reaches init)
		expect(serviceFactory).toHaveBeenCalledOnce();

		// logger.error must have been called with a message containing "Duplicate"
		const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
		const duplicateError = errorCalls.find(
			(args: unknown[]) => typeof args[1] === 'string' && args[1].includes('Duplicate'),
		);
		expect(duplicateError).toBeDefined();
	});

	it('loads a compiled app through loadAll when src/index.ts is broken', async () => {
		const appDir = join(tempDir, 'compiled-echo');
		await mkdir(join(appDir, 'dist'), { recursive: true });
		await mkdir(join(appDir, 'src'), { recursive: true });
		await writeFile(join(appDir, 'manifest.yaml'), validManifestYaml);
		await writeFile(join(appDir, 'package.json'), JSON.stringify({ main: 'dist/index.js' }));
		await writeFile(
			join(appDir, 'dist', 'index.js'),
			`
			export default {
				async init() {},
				async handleMessage() {},
			};
		`,
		);
		await writeFile(join(appDir, 'src', 'index.ts'), 'this is not valid ts');

		const registry = new AppRegistry({ appsDir: tempDir, config, logger });
		const serviceFactory = createMockServiceFactory();

		await registry.loadAll(serviceFactory);

		expect(registry.getLoadedAppIds()).toContain('echo');
		expect(registry.getApp('echo')).toBeDefined();
		expect(serviceFactory).toHaveBeenCalledOnce();
	});
});
