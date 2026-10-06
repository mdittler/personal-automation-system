import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveCache } from '../runner/archive-cache.js';

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'archive-'));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('archiveCache (REQ-REG-027)', () => {
	it('moves the cache dir under <cacheDir>-archive/<stamp> and leaves an empty cache dir', async () => {
		const cacheDir = join(root, 'regression-cache');
		await mkdir(join(cacheDir, 'case-a'), { recursive: true });
		await writeFile(join(cacheDir, 'case-a', 'k.json'), '{"x":1}');
		const dest = await archiveCache(cacheDir, new Date('2026-10-05T12:34:56.000Z'));
		expect(dest).toBe(join(root, 'regression-cache-archive', '2026-10-05T12-34-56-000Z'));
		expect(await readFile(join(dest!, 'case-a', 'k.json'), 'utf8')).toBe('{"x":1}');
		expect(existsSync(cacheDir)).toBe(true);
		expect(existsSync(join(cacheDir, 'case-a'))).toBe(false);
	});

	it('returns null when there is no cache dir', async () => {
		expect(await archiveCache(join(root, 'nope'), new Date())).toBeNull();
	});
});
