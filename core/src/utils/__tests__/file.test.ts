import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite, ensureDir } from '../file.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-file-test-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('ensureDir', () => {
	it('creates nested directories', async () => {
		const nested = join(tempDir, 'a', 'b', 'c');
		await ensureDir(nested);
		expect(existsSync(nested)).toBe(true);
	});

	it('is idempotent — calling twice does not error', async () => {
		const dir = join(tempDir, 'idempotent');
		await ensureDir(dir);
		await expect(ensureDir(dir)).resolves.toBeUndefined();
		expect(existsSync(dir)).toBe(true);
	});
});

describe('atomicWrite', () => {
	it('creates file with correct content', async () => {
		const filePath = join(tempDir, 'test.txt');
		await atomicWrite(filePath, 'hello world');
		expect(readFileSync(filePath, 'utf-8')).toBe('hello world');
	});

	it('creates parent directories', async () => {
		const filePath = join(tempDir, 'deep', 'nested', 'file.txt');
		await atomicWrite(filePath, 'nested content');
		expect(readFileSync(filePath, 'utf-8')).toBe('nested content');
	});

	it('overwrites existing file', async () => {
		const filePath = join(tempDir, 'overwrite.txt');
		await atomicWrite(filePath, 'first');
		await atomicWrite(filePath, 'second');
		expect(readFileSync(filePath, 'utf-8')).toBe('second');
	});

	it('leaves no temp file after completion', async () => {
		const filePath = join(tempDir, 'clean.txt');
		await atomicWrite(filePath, 'data');

		const files = readdirSync(tempDir);
		const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
		expect(tmpFiles).toHaveLength(0);
	});
});
