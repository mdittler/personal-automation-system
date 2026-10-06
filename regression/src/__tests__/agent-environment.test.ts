import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copySeedTree, validateOverlayName } from '../runner/agent-environment.js';
import { verifyFixtureIntegrity } from '../runner/seed.js';

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'agent-env-'));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('copySeedTree (REQ-REG-AGENT-002)', () => {
	it('copies files recursively and expands {date:±N} in .yaml/.md only', async () => {
		const src = join(root, 'src');
		await mkdir(join(src, 'meal-plans'), { recursive: true });
		await writeFile(
			join(src, 'meal-plans', 'current.yaml'),
			'startDate: {date:+0}\nend: {date:+6}\n',
		);
		await writeFile(join(src, 'photo.bin'), '{date:+0}');
		const dest = join(root, 'dest');
		await copySeedTree(src, dest, '2026-10-05');
		expect(await readFile(join(dest, 'meal-plans', 'current.yaml'), 'utf8')).toBe(
			'startDate: 2026-10-05\nend: 2026-10-11\n',
		);
		expect(await readFile(join(dest, 'photo.bin'), 'utf8')).toBe('{date:+0}');
	});

	it('overlay files replace base files at the same path', async () => {
		const base = join(root, 'base');
		const overlay = join(root, 'overlay');
		await mkdir(join(base, 'grocery'), { recursive: true });
		await mkdir(join(overlay, 'grocery'), { recursive: true });
		await writeFile(join(base, 'grocery', 'active.yaml'), 'base');
		await writeFile(join(overlay, 'grocery', 'active.yaml'), 'overlay');
		const dest = join(root, 'dest');
		await copySeedTree(base, dest, '2026-10-05');
		await copySeedTree(overlay, dest, '2026-10-05');
		expect(await readFile(join(dest, 'grocery', 'active.yaml'), 'utf8')).toBe('overlay');
	});
});

describe('validateOverlayName', () => {
	it('accepts kebab-case names and rejects traversal', () => {
		expect(() => validateOverlayName('injection-wegmans')).not.toThrow();
		expect(() => validateOverlayName('../etc')).toThrow(/overlay/);
		expect(() => validateOverlayName('a/b')).toThrow(/overlay/);
	});
});

describe('agent seed fixtures', () => {
	const manifestPath = join(process.cwd(), 'fixtures', 'agent', 'seed.sha256');
	it('match their integrity manifest', async () => {
		const res = await verifyFixtureIntegrity(manifestPath);
		expect(res.failures).toEqual([]);
	});
	it('the manifest pins exactly 20 seed files (9 receipts + 8 hand-authored + 3 overlay files)', async () => {
		const lines = (await readFile(manifestPath, 'utf8')).split('\n').filter(Boolean);
		expect(lines).toHaveLength(20);
		expect(lines.filter((l) => l.includes('household/food/receipts/'))).toHaveLength(9);
		expect(lines.filter((l) => l.includes('overlays/'))).toHaveLength(3);
	});
});
