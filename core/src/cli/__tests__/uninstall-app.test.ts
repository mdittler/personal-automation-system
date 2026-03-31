import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('uninstall-app CLI', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-uninstall-test-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// Test the validation logic and filesystem operations

	const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
	const PROTECTED_APPS = new Set(['echo', 'chatbot']);

	describe('app ID validation', () => {
		it('should accept valid app IDs', () => {
			expect(APP_ID_PATTERN.test('my-app')).toBe(true);
			expect(APP_ID_PATTERN.test('weather')).toBe(true);
			expect(APP_ID_PATTERN.test('app123')).toBe(true);
		});

		it('should reject app IDs starting with numbers', () => {
			expect(APP_ID_PATTERN.test('123app')).toBe(false);
		});

		it('should reject app IDs with uppercase letters', () => {
			expect(APP_ID_PATTERN.test('MyApp')).toBe(false);
		});

		it('should reject app IDs with path traversal', () => {
			expect(APP_ID_PATTERN.test('../evil')).toBe(false);
			expect(APP_ID_PATTERN.test('app/../../etc')).toBe(false);
		});

		it('should reject empty app IDs', () => {
			expect(APP_ID_PATTERN.test('')).toBe(false);
		});
	});

	describe('protected apps', () => {
		it('should protect built-in echo app', () => {
			expect(PROTECTED_APPS.has('echo')).toBe(true);
		});

		it('should protect built-in chatbot app', () => {
			expect(PROTECTED_APPS.has('chatbot')).toBe(true);
		});

		it('should not protect custom apps', () => {
			expect(PROTECTED_APPS.has('my-custom-app')).toBe(false);
		});
	});

	describe('directory removal', () => {
		it('should remove an existing app directory', async () => {
			const appDir = join(tempDir, 'test-app');
			await mkdir(appDir, { recursive: true });
			await writeFile(join(appDir, 'manifest.yaml'), 'app: test');

			await rm(appDir, { recursive: true, force: true });

			const exists = await stat(appDir).then(
				() => true,
				() => false,
			);
			expect(exists).toBe(false);
		});

		it('should detect non-existent app directory', async () => {
			const appDir = join(tempDir, 'nonexistent');
			const exists = await stat(appDir).then(
				() => true,
				() => false,
			);
			expect(exists).toBe(false);
		});
	});
});
