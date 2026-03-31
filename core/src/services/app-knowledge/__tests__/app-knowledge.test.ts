import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppKnowledgeBase, type AppKnowledgeBaseOptions } from '../index.js';

describe('AppKnowledgeBase', () => {
	let tempDir: string;
	let infraDir: string;
	let appsDir: string;

	const mockRegistry = {
		getAll: vi.fn().mockReturnValue([]),
		getApp: vi.fn(),
		getLoadedAppIds: vi.fn(),
		getManifestCache: vi.fn(),
		loadAll: vi.fn(),
		shutdownAll: vi.fn(),
	};

	const mockAppToggle = {
		isEnabled: vi.fn().mockResolvedValue(true),
		setEnabled: vi.fn(),
		getOverrides: vi.fn(),
		getAllOverrides: vi.fn(),
	};

	const mockConfig = {
		users: [{ id: 'user1', name: 'Alice', isAdmin: true, enabledApps: ['*'], sharedScopes: [] }],
	};

	const mockLogger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};

	let svc: AppKnowledgeBase;

	beforeEach(async () => {
		vi.clearAllMocks();
		tempDir = await mkdtemp(join(tmpdir(), 'pas-knowledge-'));
		infraDir = join(tempDir, 'infra-docs');
		appsDir = join(tempDir, 'apps');
		await mkdir(infraDir, { recursive: true });
		await mkdir(appsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function createService(): AppKnowledgeBase {
		return new AppKnowledgeBase({
			registry: mockRegistry,
			appToggle: mockAppToggle,
			config: mockConfig,
			infraDocsDir: infraDir,
			logger: mockLogger,
		} as unknown as AppKnowledgeBaseOptions);
	}

	function makeApp(id: string, appDir: string) {
		return {
			manifest: {
				app: { id, name: id, version: '1.0.0', description: `${id} app`, author: 'Test' },
			},
			module: { init: vi.fn(), handleMessage: vi.fn() },
			appDir,
		};
	}

	// -- Standard --

	describe('init and indexing', () => {
		it('loads infrastructure docs from infraDocsDir', async () => {
			await writeFile(join(infraDir, 'routing.md'), '# Routing\nHow messages are routed.');
			svc = createService();

			await svc.init();

			const results = await svc.search('routing');
			expect(results).toHaveLength(1);
			expect(results[0].appId).toBe('infrastructure');
			expect(results[0].source).toBe('routing.md');
			expect(results[0].content).toContain('How messages are routed');
		});

		it('loads help.md from app directory', async () => {
			const appDir = join(appsDir, 'echo');
			await mkdir(appDir, { recursive: true });
			await writeFile(join(appDir, 'help.md'), '# Echo Help\nUse /echo to echo messages.');
			mockRegistry.getAll.mockReturnValue([makeApp('echo', appDir)]);

			svc = createService();
			await svc.init();

			const results = await svc.search('echo');
			expect(results).toHaveLength(1);
			expect(results[0].appId).toBe('echo');
			expect(results[0].source).toBe('help.md');
		});

		it('loads docs/*.md from app directory', async () => {
			const appDir = join(appsDir, 'weather');
			await mkdir(join(appDir, 'docs'), { recursive: true });
			await writeFile(join(appDir, 'docs', 'setup.md'), '# Setup\nConfigure your weather API key.');
			await writeFile(join(appDir, 'docs', 'usage.md'), '# Usage\nSend weather queries.');
			mockRegistry.getAll.mockReturnValue([makeApp('weather', appDir)]);

			svc = createService();
			await svc.init();

			// Both docs contain "weather" and should be indexed
			const results = await svc.search('weather');
			expect(results).toHaveLength(2);
			const sources = results.map((r) => r.source);
			expect(sources).toContain('setup.md');
			expect(sources).toContain('usage.md');
		});

		it('logs the total indexed entry count', async () => {
			await writeFile(join(infraDir, 'test.md'), '# Test doc');
			svc = createService();

			await svc.init();

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.objectContaining({ count: 1 }),
				expect.stringContaining('indexed'),
			);
		});
	});

	describe('search', () => {
		it('returns entries matching query keywords', async () => {
			await writeFile(
				join(infraDir, 'scheduling.md'),
				'# Scheduling\nCron jobs and one-off tasks.',
			);
			await writeFile(join(infraDir, 'routing.md'), '# Routing\nHow commands are matched.');
			svc = createService();
			await svc.init();

			const results = await svc.search('scheduling cron');
			expect(results).toHaveLength(1);
			expect(results[0].source).toBe('scheduling.md');
		});

		it('ranks results by keyword match count', async () => {
			await writeFile(join(infraDir, 'a.md'), 'data storage');
			await writeFile(join(infraDir, 'b.md'), 'data storage and data management');
			svc = createService();
			await svc.init();

			const results = await svc.search('data storage management');
			// b.md matches more words
			expect(results[0].source).toBe('b.md');
		});

		it('filters by enabled apps when userId provided', async () => {
			const appDir = join(appsDir, 'disabled-app');
			await mkdir(appDir, { recursive: true });
			await writeFile(join(appDir, 'help.md'), '# Help for disabled app');
			mockRegistry.getAll.mockReturnValue([makeApp('disabled-app', appDir)]);
			mockAppToggle.isEnabled.mockResolvedValue(false);

			svc = createService();
			await svc.init();

			const results = await svc.search('disabled', 'user1');
			expect(results).toHaveLength(0);
		});

		it('always includes infrastructure docs regardless of userId', async () => {
			await writeFile(join(infraDir, 'core.md'), '# Core concepts');
			svc = createService();
			await svc.init();

			const results = await svc.search('core concepts', 'user1');
			expect(results).toHaveLength(1);
			expect(results[0].appId).toBe('infrastructure');
		});

		it('limits results to 5', async () => {
			for (let i = 0; i < 10; i++) {
				await writeFile(join(infraDir, `doc${i}.md`), `# Doc ${i}\nCommon keyword here.`);
			}
			svc = createService();
			await svc.init();

			const results = await svc.search('common keyword');
			expect(results.length).toBeLessThanOrEqual(5);
		});
	});

	// -- Edge cases --

	describe('edge cases', () => {
		it('returns empty for empty query', async () => {
			await writeFile(join(infraDir, 'test.md'), '# Test');
			svc = createService();
			await svc.init();

			expect(await svc.search('')).toEqual([]);
			expect(await svc.search('   ')).toEqual([]);
		});

		it('returns empty when no entries match', async () => {
			await writeFile(join(infraDir, 'test.md'), '# About cats');
			svc = createService();
			await svc.init();

			expect(await svc.search('quantum physics')).toEqual([]);
		});

		it('handles app with no help.md or docs/', async () => {
			const appDir = join(appsDir, 'no-docs');
			await mkdir(appDir, { recursive: true });
			mockRegistry.getAll.mockReturnValue([makeApp('no-docs', appDir)]);

			svc = createService();
			await svc.init();

			// Should not error, just no entries from this app
			const results = await svc.search('no-docs');
			expect(results).toEqual([]);
		});

		it('ignores non-markdown files', async () => {
			await writeFile(join(infraDir, 'notes.txt'), 'Not a markdown file');
			await writeFile(join(infraDir, 'data.json'), '{"key": "value"}');
			svc = createService();
			await svc.init();

			expect(await svc.search('notes')).toEqual([]);
		});

		it('truncates large files to max content length', async () => {
			const bigContent = 'x'.repeat(5000);
			await writeFile(join(infraDir, 'big.md'), bigContent);
			svc = createService();
			await svc.init();

			const results = await svc.search('xxx');
			expect(results).toHaveLength(1);
			expect(results[0].content.length).toBeLessThanOrEqual(2000);
		});

		it('filters out short query words (<=2 chars)', async () => {
			await writeFile(join(infraDir, 'test.md'), '# Test document about is a the');
			svc = createService();
			await svc.init();

			// 'is' and 'a' are too short to be keywords
			expect(await svc.search('is a')).toEqual([]);
		});
	});

	// -- Error handling --

	describe('error handling', () => {
		it('handles missing infrastructure docs directory gracefully', async () => {
			const missingDir = join(tempDir, 'nonexistent');
			svc = new AppKnowledgeBase({
				registry: mockRegistry,
				appToggle: mockAppToggle,
				config: mockConfig,
				infraDocsDir: missingDir,
				logger: mockLogger,
			} as unknown as AppKnowledgeBaseOptions);

			await svc.init();
			expect(await svc.search('anything')).toEqual([]);
		});

		it('handles missing app directory gracefully', async () => {
			mockRegistry.getAll.mockReturnValue([makeApp('ghost', join(tempDir, 'nonexistent-app'))]);

			svc = createService();
			await svc.init();
			// Should not throw
			expect(await svc.search('ghost')).toEqual([]);
		});
	});
});
