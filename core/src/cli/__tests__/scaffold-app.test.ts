import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateManifest } from '../../schemas/validate-manifest.js';
import { parseYaml } from '../../utils/yaml.js';
import { scaffoldApp } from '../scaffold-app.js';

describe('scaffold-app', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			`pas-scaffold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	describe('Standard', () => {
		it('should generate correct directory structure', async () => {
			const result = await scaffoldApp(
				{ name: 'test-app', description: 'A test app.', author: 'Test' },
				tempDir,
			);

			expect(result.success).toBe(true);
			const appDir = join(tempDir, 'test-app');
			expect(existsSync(join(appDir, 'manifest.yaml'))).toBe(true);
			expect(existsSync(join(appDir, 'package.json'))).toBe(true);
			expect(existsSync(join(appDir, 'tsconfig.json'))).toBe(true);
			expect(existsSync(join(appDir, 'src', 'index.ts'))).toBe(true);
			expect(existsSync(join(appDir, 'src', '__tests__', 'app.test.ts'))).toBe(true);
			expect(existsSync(join(appDir, 'docs', 'urs.md'))).toBe(true);
			expect(existsSync(join(appDir, 'docs', 'requirements.md'))).toBe(true);
		});

		it('should replace all placeholders in manifest', async () => {
			await scaffoldApp({ name: 'my-app', description: 'My cool app.', author: 'Jane' }, tempDir);

			const manifest = await readFile(join(tempDir, 'my-app', 'manifest.yaml'), 'utf-8');
			expect(manifest).toContain('id: my-app');
			expect(manifest).toContain('name: "My App"');
			expect(manifest).toContain('description: "My cool app."');
			expect(manifest).toContain('author: "Jane"');
			expect(manifest).not.toContain('{{');
		});

		it('should replace all placeholders in package.json', async () => {
			await scaffoldApp({ name: 'my-app', description: 'My cool app.', author: 'Jane' }, tempDir);

			const pkg = await readFile(join(tempDir, 'my-app', 'package.json'), 'utf-8');
			expect(pkg).toContain('"@pas/my-app"');
			expect(pkg).toContain('"My cool app."');
			expect(pkg).not.toContain('{{');
		});

		it('should generate manifest that passes JSON Schema validation', async () => {
			await scaffoldApp({ name: 'valid-app', description: 'Valid.', author: 'Dev' }, tempDir);

			const manifestContent = await readFile(join(tempDir, 'valid-app', 'manifest.yaml'), 'utf-8');
			const parsed = parseYaml(manifestContent);
			const result = validateManifest(parsed);
			expect(result.valid).toBe(true);
		});

		it('should use custom description and author when provided', async () => {
			await scaffoldApp(
				{ name: 'custom', description: 'Custom desc.', author: 'Custom Author' },
				tempDir,
			);

			const manifest = await readFile(join(tempDir, 'custom', 'manifest.yaml'), 'utf-8');
			expect(manifest).toContain('description: "Custom desc."');
			expect(manifest).toContain('author: "Custom Author"');
		});

		it('should derive display name from kebab-case ID', async () => {
			await scaffoldApp({ name: 'my-cool-app', description: 'Test.', author: 'Dev' }, tempDir);

			const manifest = await readFile(join(tempDir, 'my-cool-app', 'manifest.yaml'), 'utf-8');
			expect(manifest).toContain('name: "My Cool App"');
		});

		it('should replace placeholders in test file', async () => {
			await scaffoldApp({ name: 'my-app', description: 'Test.', author: 'Dev' }, tempDir);

			const testFile = await readFile(
				join(tempDir, 'my-app', 'src', '__tests__', 'app.test.ts'),
				'utf-8',
			);
			expect(testFile).toContain("describe('My App'");
			expect(testFile).toContain("'/my_app'");
			expect(testFile).not.toContain('{{');
		});

		it('should generate docs directory with URS and requirements', async () => {
			await scaffoldApp({ name: 'test-app', description: 'A test app.', author: 'Test' }, tempDir);

			const appDir = join(tempDir, 'test-app');
			expect(existsSync(join(appDir, 'docs', 'urs.md'))).toBe(true);
			expect(existsSync(join(appDir, 'docs', 'requirements.md'))).toBe(true);
		});

		it('should replace placeholders in URS template', async () => {
			await scaffoldApp({ name: 'my-app', description: 'Test.', author: 'Dev' }, tempDir);

			const urs = await readFile(join(tempDir, 'my-app', 'docs', 'urs.md'), 'utf-8');
			expect(urs).toContain('PAS-URS-APP-my-app');
			expect(urs).toContain('# My App User Requirements Specification');
			expect(urs).not.toContain('{{');
		});

		it('should replace placeholders in requirements template', async () => {
			await scaffoldApp({ name: 'my-app', description: 'Test.', author: 'Dev' }, tempDir);

			const reqs = await readFile(join(tempDir, 'my-app', 'docs', 'requirements.md'), 'utf-8');
			expect(reqs).toContain('# My App Requirements');
			expect(reqs).toContain('my-app.example.event');
			expect(reqs).not.toContain('{{');
		});

		it('should return the app directory path on success', async () => {
			const result = await scaffoldApp(
				{ name: 'my-app', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(true);
			expect(result.appDir).toBe(join(tempDir, 'my-app'));
		});
	});

	describe('Edge cases', () => {
		it('should reject uppercase app name', async () => {
			const result = await scaffoldApp(
				{ name: 'MyApp', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid app name');
		});

		it('should reject name starting with number', async () => {
			const result = await scaffoldApp(
				{ name: '1app', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid app name');
		});

		it('should reject special characters in name', async () => {
			const result = await scaffoldApp(
				{ name: 'my_app!', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid app name');
		});

		it('should reject empty name', async () => {
			const result = await scaffoldApp({ name: '', description: 'Test.', author: 'Dev' }, tempDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid app name');
		});

		it('should reject existing directory', async () => {
			await mkdir(join(tempDir, 'existing'), { recursive: true });
			const result = await scaffoldApp(
				{ name: 'existing', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('already exists');
		});

		it('should reject reserved name "shared"', async () => {
			const result = await scaffoldApp(
				{ name: 'shared', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('reserved name');
		});

		it('should reject reserved name "system"', async () => {
			const result = await scaffoldApp(
				{ name: 'system', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('reserved name');
		});

		it('should reject reserved name "core"', async () => {
			const result = await scaffoldApp(
				{ name: 'core', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('reserved name');
		});

		it('should reject reserved name "pas"', async () => {
			const result = await scaffoldApp(
				{ name: 'pas', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('reserved name');
		});

		it('should reject reserved name "internal"', async () => {
			const result = await scaffoldApp(
				{ name: 'internal', description: 'Test.', author: 'Dev' },
				tempDir,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('reserved name');
		});
	});
});
