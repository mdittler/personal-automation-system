import { execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeCacheKey } from '../shared/cache-key.js';
import { hashRepoRelative } from '../shared/git-hash.js';

let tempRepo: string;

beforeEach(async () => {
	tempRepo = await mkdtemp(join(tmpdir(), 'regression-cache-key-'));
	execSync('git init -q', { cwd: tempRepo });
	execSync('git config user.email t@t', { cwd: tempRepo });
	execSync('git config user.name T', { cwd: tempRepo });
});
afterEach(async () => {
	await rm(tempRepo, { recursive: true, force: true });
});

describe('hashRepoRelative', () => {
	it('returns a 40-char SHA-1 for a tracked clean file (git blob)', async () => {
		await writeFile(join(tempRepo, 'a.ts'), 'export const x = 1;\n');
		execSync('git add a.ts && git commit -q -m init', { cwd: tempRepo });
		const h = await hashRepoRelative('a.ts', { repoRoot: tempRepo });
		expect(h).toMatch(/^[0-9a-f]{40}$/);
	});

	it('falls back to 64-char SHA-256 for an untracked file', async () => {
		await writeFile(join(tempRepo, 'b.ts'), 'unstaged\n');
		const h = await hashRepoRelative('b.ts', { repoRoot: tempRepo });
		expect(h).toMatch(/^[0-9a-f]{64}$/);
	});

	it('falls back to SHA-256 when file is tracked but modified', async () => {
		await writeFile(join(tempRepo, 'c.ts'), 'orig\n');
		execSync('git add c.ts && git commit -q -m c', { cwd: tempRepo });
		await writeFile(join(tempRepo, 'c.ts'), 'modified\n');
		const h = await hashRepoRelative('c.ts', { repoRoot: tempRepo });
		expect(h).toMatch(/^[0-9a-f]{64}$/);
	});

	it('rejects an absolute path', async () => {
		await expect(hashRepoRelative('/etc/passwd', { repoRoot: tempRepo })).rejects.toThrow(
			/relative|absolute/i,
		);
	});

	it('rejects a path that escapes the repo root', async () => {
		await expect(hashRepoRelative('../escape.ts', { repoRoot: tempRepo })).rejects.toThrow(
			/outside|traversal/i,
		);
	});

	it('rejects path containing parent-segment in middle (apps/food/../sneaky.ts)', async () => {
		await expect(
			hashRepoRelative('apps/food/../sneaky.ts', { repoRoot: tempRepo }),
		).rejects.toThrow(/outside|traversal/i);
	});

	it('throws ENOENT-like error if the file does not exist', async () => {
		await expect(hashRepoRelative('nope.ts', { repoRoot: tempRepo })).rejects.toThrow();
	});
});

describe('computeCacheKey', () => {
	async function track(name: string, content: string): Promise<void> {
		await writeFile(join(tempRepo, name), content);
		execSync(`git add "${name}" && git commit -q -m ${name}`, { cwd: tempRepo });
	}

	it('produces deterministic keys across calls', async () => {
		await track('a.ts', 'a\n');
		const args = {
			casePath: 'a.ts',
			coveragePaths: ['a.ts'],
			modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
			repoRoot: tempRepo,
		};
		expect(await computeCacheKey(args)).toBe(await computeCacheKey(args));
	});

	it('changes when fast/standard/reasoning model id changes', async () => {
		await track('a.ts', 'a\n');
		const base = { casePath: 'a.ts', coveragePaths: ['a.ts'], repoRoot: tempRepo };
		const k1 = await computeCacheKey({
			...base,
			modelIds: { fast: 'A', standard: 'B', reasoning: 'C' },
		});
		const k2 = await computeCacheKey({
			...base,
			modelIds: { fast: 'X', standard: 'B', reasoning: 'C' },
		});
		expect(k1).not.toBe(k2);
	});

	it('treats reasoning=null differently from reasoning="r"', async () => {
		await track('a.ts', 'a\n');
		const base = { casePath: 'a.ts', coveragePaths: ['a.ts'], repoRoot: tempRepo };
		const kNull = await computeCacheKey({
			...base,
			modelIds: { fast: 'f', standard: 's', reasoning: null },
		});
		const kSet = await computeCacheKey({
			...base,
			modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
		});
		expect(kNull).not.toBe(kSet);
	});

	it('sorts coverage paths alphabetically', async () => {
		await track('a.ts', 'a\n');
		await track('b.ts', 'b\n');
		const base = {
			casePath: 'a.ts',
			modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
			repoRoot: tempRepo,
		};
		expect(await computeCacheKey({ ...base, coveragePaths: ['a.ts', 'b.ts'] })).toBe(
			await computeCacheKey({ ...base, coveragePaths: ['b.ts', 'a.ts'] }),
		);
	});

	it('changes when the case file changes', async () => {
		await track('a.ts', 'a-v1\n');
		const base = {
			casePath: 'a.ts',
			coveragePaths: ['a.ts'],
			modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
			repoRoot: tempRepo,
		};
		const k1 = await computeCacheKey(base);
		await writeFile(join(tempRepo, 'a.ts'), 'a-v2\n');
		execSync('git add a.ts && git commit -q -m bump', { cwd: tempRepo });
		const k2 = await computeCacheKey(base);
		expect(k1).not.toBe(k2);
	});

	it('changes when an untracked coverage file is modified', async () => {
		await track('a.ts', 'a\n');
		await writeFile(join(tempRepo, 'b.ts'), 'b\n'); // untracked
		const base = {
			casePath: 'a.ts',
			coveragePaths: ['a.ts', 'b.ts'],
			modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
			repoRoot: tempRepo,
		};
		const k1 = await computeCacheKey(base);
		await writeFile(join(tempRepo, 'b.ts'), 'b-modified\n');
		const k2 = await computeCacheKey(base);
		expect(k1).not.toBe(k2);
	});

	it('throws when a coverage path is missing entirely', async () => {
		await track('a.ts', 'a\n');
		await expect(
			computeCacheKey({
				casePath: 'a.ts',
				coveragePaths: ['a.ts', 'gone.ts'],
				modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
				repoRoot: tempRepo,
			}),
		).rejects.toThrow();
	});

	it('rejects absolute paths in coveragePaths', async () => {
		await track('a.ts', 'a\n');
		await expect(
			computeCacheKey({
				casePath: 'a.ts',
				coveragePaths: [join(tempRepo, 'a.ts')], // absolute
				modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
				repoRoot: tempRepo,
			}),
		).rejects.toThrow(/relative|absolute/i);
	});

	// Receipt bucket — `extraSalt` binds the cache key to today's date +
	// timezone so the rejection-mode fixture re-exercises on date rollover.
	describe('extraSalt (receipt-bucket date binding)', () => {
		it('produces different keys for different extraSalt values', async () => {
			await track('a.ts', 'a\n');
			const base = {
				casePath: 'a.ts',
				coveragePaths: ['a.ts'],
				modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
				repoRoot: tempRepo,
			};
			const day1 = await computeCacheKey({ ...base, extraSalt: 'today:2026-05-15:tz:UTC' });
			const day2 = await computeCacheKey({ ...base, extraSalt: 'today:2026-05-16:tz:UTC' });
			expect(day1).not.toBe(day2);
		});

		it('omitted extraSalt produces the original (legacy) cache key — backward compat', async () => {
			await track('a.ts', 'a\n');
			const base = {
				casePath: 'a.ts',
				coveragePaths: ['a.ts'],
				modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
				repoRoot: tempRepo,
			};
			const legacy = await computeCacheKey(base);
			const reRun = await computeCacheKey(base);
			expect(legacy).toBe(reRun);
			expect(legacy).not.toBe(
				await computeCacheKey({ ...base, extraSalt: 'today:2026-05-15:tz:UTC' }),
			);
		});

		it('empty-string extraSalt is distinct from omitted (defensive: "" is a real value)', async () => {
			await track('a.ts', 'a\n');
			const base = {
				casePath: 'a.ts',
				coveragePaths: ['a.ts'],
				modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
				repoRoot: tempRepo,
			};
			const omitted = await computeCacheKey(base);
			const empty = await computeCacheKey({ ...base, extraSalt: '' });
			expect(omitted).not.toBe(empty);
		});

		it('timezone change produces different key (DST-relevant edge: same date string, different tz)', async () => {
			await track('a.ts', 'a\n');
			const base = {
				casePath: 'a.ts',
				coveragePaths: ['a.ts'],
				modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
				repoRoot: tempRepo,
			};
			const ny = await computeCacheKey({
				...base,
				extraSalt: 'today:2026-05-15:tz:America/New_York',
			});
			const utc = await computeCacheKey({
				...base,
				extraSalt: 'today:2026-05-15:tz:UTC',
			});
			expect(ny).not.toBe(utc);
		});
	});

	// Codex round-3 #2: SHA sidecar inclusion in cache coverage.
	//
	// Receipt cases include BOTH `.transcription.yaml` AND its companion
	// `.transcription.sha256` in `coverage`. A cache hit short-circuits the
	// loader's runtime SHA check, so if someone edits ONLY the SHA file
	// (corruption, tampering, partial sync), the cache key would not change
	// and the prior verdict would be served stale. With BOTH files in coverage,
	// a SHA-only edit invalidates the cache → re-dispatch → loader catches the
	// mismatch → 'error' verdict surfaces correctly.
	describe('SHA sidecar coverage (transcription cache invalidation)', () => {
		it('editing only the .sha256 sidecar produces a different cache key', async () => {
			await track('a.ts', 'a\n');
			// Simulate the transcription YAML + SHA sidecar pair as untracked
			// coverage files (mirrors how the receipt-bucket fixtures live
			// outside the test git repo and are picked up by `hashRepoRelative`'s
			// SHA-256 fallback).
			const yaml = 'total: 5\nlineItems:\n  - name: A\n    totalPrice: 5\n';
			await writeFile(join(tempRepo, 'receipt.transcription.yaml'), yaml);
			await writeFile(
				join(tempRepo, 'receipt.transcription.sha256'),
				'a'.repeat(64),
			);
			const base = {
				casePath: 'a.ts',
				coveragePaths: [
					'a.ts',
					'receipt.transcription.yaml',
					'receipt.transcription.sha256',
				],
				modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
				repoRoot: tempRepo,
			};
			const before = await computeCacheKey(base);
			// Edit ONLY the SHA sidecar; YAML content untouched.
			await writeFile(
				join(tempRepo, 'receipt.transcription.sha256'),
				'b'.repeat(64),
			);
			const after = await computeCacheKey(base);
			expect(after).not.toBe(before);
		});
	});
});
