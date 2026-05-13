/**
 * Tests for the shared `atomicWriteJson` helper. Covers happy path,
 * unwritable directory, mkdir-on-write, atomicity (no partial file
 * visible at the final path), and concurrent writers.
 *
 * REQ-REG-GUI-V2-002.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteJson } from '../runner/atomic-write.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'atomic-write-'));
});
afterEach(async () => {
	// Restore perms in case a test chmod'd a directory to read-only.
	try {
		await chmod(tempDir, 0o755);
	} catch {
		/* ignore */
	}
	await rm(tempDir, { recursive: true, force: true });
});

describe('atomicWriteJson — happy path', () => {
	it('writes a JSON file at the requested path', async () => {
		const path = join(tempDir, 'out.json');
		await atomicWriteJson(path, { hello: 'world' });
		const round = JSON.parse(await readFile(path, 'utf8'));
		expect(round).toEqual({ hello: 'world' });
	});

	it('creates missing parent directories (mkdir -p)', async () => {
		const path = join(tempDir, 'nested', 'deeply', 'out.json');
		await atomicWriteJson(path, { ok: true });
		const round = JSON.parse(await readFile(path, 'utf8'));
		expect(round).toEqual({ ok: true });
	});

	it('uses 2-space indent by default', async () => {
		const path = join(tempDir, 'out.json');
		await atomicWriteJson(path, { a: 1, b: 2 });
		const raw = await readFile(path, 'utf8');
		expect(raw).toBe('{\n  "a": 1,\n  "b": 2\n}');
	});

	it('respects custom indent override', async () => {
		const path = join(tempDir, 'out.json');
		await atomicWriteJson(path, { a: 1 }, { indent: 0 });
		const raw = await readFile(path, 'utf8');
		expect(raw).toBe('{"a":1}');
	});

	it('overwrites existing file atomically (rename swaps in new content)', async () => {
		const path = join(tempDir, 'out.json');
		await atomicWriteJson(path, { v: 1 });
		await atomicWriteJson(path, { v: 2 });
		const round = JSON.parse(await readFile(path, 'utf8'));
		expect(round).toEqual({ v: 2 });
	});
});

describe('atomicWriteJson — cleanup + atomicity', () => {
	it('leaves no temp files behind after a successful write', async () => {
		const path = join(tempDir, 'out.json');
		await atomicWriteJson(path, { hi: 1 });
		const files = await readdir(tempDir);
		expect(files).toEqual(['out.json']);
	});

	it('handles concurrent writers without collision (last-write-wins, no torn file)', async () => {
		const path = join(tempDir, 'out.json');
		const writers = Array.from({ length: 8 }, (_, i) =>
			atomicWriteJson(path, { writer: i, payload: 'x'.repeat(1024) }),
		);
		await Promise.all(writers);
		const raw = await readFile(path, 'utf8');
		const parsed = JSON.parse(raw); // must parse — no torn write
		expect(typeof parsed.writer).toBe('number');
		expect(parsed.payload).toBe('x'.repeat(1024));
		// no leftover temp files
		const files = await readdir(tempDir);
		expect(files).toEqual(['out.json']);
	});
});

describe('atomicWriteJson — error paths', () => {
	it('rejects when the destination directory cannot be created (file blocks parent)', async () => {
		// Create a regular file where we need a directory.
		const blocking = join(tempDir, 'blocker');
		await atomicWriteJson(blocking, { i: 1 });
		const target = join(blocking, 'nested', 'out.json');
		await expect(atomicWriteJson(target, { x: 1 })).rejects.toBeInstanceOf(Error);
	});

	it('rejects when the parent is unwritable (POSIX)', async () => {
		// Skip on Windows where chmod semantics differ.
		if (process.platform === 'win32') return;
		// Skip when running as root (chmod has no effect).
		if (typeof process.getuid === 'function' && process.getuid() === 0) return;
		const dir = join(tempDir, 'readonly');
		await mkdir(dir);
		await chmod(dir, 0o555);
		const target = join(dir, 'out.json');
		await expect(atomicWriteJson(target, { x: 1 })).rejects.toBeInstanceOf(Error);
		// Restore so afterEach can rm.
		await chmod(dir, 0o755);
	});
});
