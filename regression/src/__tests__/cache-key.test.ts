import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	BUCKET_HARNESS_PATHS,
	COMMON_HARNESS_PATHS,
	HARNESS_IMPORT_EXEMPT,
	HARNESS_IMPORT_RE,
	SUT_APP_IDS,
	clearHarnessDigestCache,
	computeCacheKey,
	expandHarnessPaths,
	harnessDigestComputeCount,
} from '../shared/cache-key.js';

/** Repo root from this file, so the suite does not assume `cwd === regression/`. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
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
			await writeFile(join(tempRepo, 'receipt.transcription.sha256'), 'a'.repeat(64));
			const base = {
				casePath: 'a.ts',
				coveragePaths: ['a.ts', 'receipt.transcription.yaml', 'receipt.transcription.sha256'],
				modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
				repoRoot: tempRepo,
			};
			const before = await computeCacheKey(base);
			// Edit ONLY the SHA sidecar; YAML content untouched.
			await writeFile(join(tempRepo, 'receipt.transcription.sha256'), 'b'.repeat(64));
			const after = await computeCacheKey(base);
			expect(after).not.toBe(before);
		});
	});
});

describe('computeCacheKey — caseId (REQ-REG-024)', () => {
	it('two cases defined in the same file get different keys', async () => {
		await writeFile(join(tempRepo, 'cases.ts'), 'export {}\n');
		const base = {
			casePath: 'cases.ts',
			coveragePaths: [],
			modelIds: { fast: 'f', standard: 's', reasoning: null },
			repoRoot: tempRepo,
		};
		const a = await computeCacheKey({ ...base, caseId: 'case-a' });
		const b = await computeCacheKey({ ...base, caseId: 'case-b' });
		expect(a).not.toBe(b);
	});
});

describe('computeCacheKey — harness paths (REQ-REG-024)', () => {
	it('changing a harness file changes the key', async () => {
		await writeFile(join(tempRepo, 'cases.ts'), 'export {}\n');
		await mkdir(join(tempRepo, 'h'), { recursive: true });
		await writeFile(join(tempRepo, 'h', 'runner.ts'), 'v1\n');
		const args = {
			casePath: 'cases.ts',
			coveragePaths: [],
			modelIds: { fast: 'f', standard: 's', reasoning: null },
			repoRoot: tempRepo,
			caseId: 'c',
			harnessPaths: ['h/'],
		};
		const before = await computeCacheKey(args);
		await writeFile(join(tempRepo, 'h', 'runner.ts'), 'v2\n');
		// The digest is memoized for the process; a content change is a new run.
		clearHarnessDigestCache();
		const after = await computeCacheKey(args);
		expect(after).not.toBe(before);
	});

	it('a missing harness file contributes a stable marker instead of throwing', async () => {
		await writeFile(join(tempRepo, 'cases.ts'), 'export {}\n');
		const args = {
			casePath: 'cases.ts',
			coveragePaths: [],
			modelIds: { fast: 'f', standard: 's', reasoning: null },
			repoRoot: tempRepo,
			caseId: 'c',
			harnessPaths: ['does/not/exist.ts'],
		};
		expect(await computeCacheKey(args)).toBe(await computeCacheKey(args));
	});

	it('expandHarnessPaths lists files under a directory entry, excluding __tests__', async () => {
		await mkdir(join(tempRepo, 'd', '__tests__'), { recursive: true });
		await writeFile(join(tempRepo, 'd', 'a.ts'), 'a\n');
		await writeFile(join(tempRepo, 'd', '__tests__', 'a.test.ts'), 't\n');
		expect(await expandHarnessPaths(['d/'], tempRepo)).toEqual(['d/a.ts']);
	});

	it('every BUCKET_HARNESS_PATHS entry exists in the real repository', () => {
		for (const paths of Object.values(BUCKET_HARNESS_PATHS)) {
			for (const p of paths) expect(existsSync(join(REPO_ROOT, p)), p).toBe(true);
		}
	});

	it('extracted modules are harness paths (review C24)', () => {
		expect(BUCKET_HARNESS_PATHS.chatbot).toContain('regression/src/runner/seeded-runtime.ts');
		for (const p of [
			'regression/src/runner/seeded-runtime.ts',
			'regression/src/runner/provider-call-tracker.ts',
			'regression/src/runner/provider-registry.ts',
			'regression/src/runner/seed.ts',
			'regression/src/runner/parent-liveness.ts',
		]) {
			expect(BUCKET_HARNESS_PATHS.agent, p).toContain(p);
		}
	});

	// Hashing a harness file does not hash its imports, so a module the worker
	// or trial pulls in must be listed itself. This test enforces the rule for
	// the agent-specific files: every `regression/src` module they value-import
	// is itself an agent harness path. Type-only imports, packages and
	// `@core/*` are excluded (the LLM layer is covered by its directory entry).
	it('every regression/src module value-imported by an agent-specific harness file is an agent harness path', async () => {
		const realRoot = REPO_ROOT;
		const agent = BUCKET_HARNESS_PATHS.agent!;
		const covered = (p: string) => agent.some((h) => (h.endsWith('/') ? p.startsWith(h) : h === p));
		const entryFiles = agent.filter(
			(p) =>
				p.startsWith('regression/src/') && p.endsWith('.ts') && !COMMON_HARNESS_PATHS.includes(p),
		);
		expect(entryFiles.length).toBeGreaterThan(5);
		for (const file of entryFiles) {
			const src = await readFile(join(realRoot, file), 'utf8');
			for (const m of src.matchAll(HARNESS_IMPORT_RE)) {
				const [, typeOnly, spec] = m;
				if (typeOnly || !spec!.startsWith('.')) continue;
				const target = relative(realRoot, resolve(realRoot, dirname(file), spec!)).replace(
					/\.js$/,
					'.ts',
				);
				if (HARNESS_IMPORT_EXEMPT.has(target)) continue;
				expect(
					covered(target),
					`${file} value-imports ${target}, which is not an agent harness path`,
				).toBe(true);
			}
		}
	});
});

/** Apps that ship both `src/` and `manifest.yaml` — the system under test. */
function appsWithSrcAndManifest(repoRoot: string): string[] {
	return readdirSync(join(repoRoot, 'apps'))
		.filter(
			(name) =>
				existsSync(join(repoRoot, 'apps', name, 'src')) &&
				existsSync(join(repoRoot, 'apps', name, 'manifest.yaml')),
		)
		.sort();
}

describe('computeCacheKey — system under test (review R1-1)', () => {
	const modelIds = { fast: 'f', standard: 's', reasoning: null as string | null };

	async function writeSut(food: string, coreSrc: string, coreTest: string): Promise<void> {
		await mkdir(join(tempRepo, 'apps/food/src/services'), { recursive: true });
		await mkdir(join(tempRepo, 'core/src/services/router'), { recursive: true });
		await mkdir(join(tempRepo, 'core/src/__tests__'), { recursive: true });
		await writeFile(join(tempRepo, 'apps/food/src/services/grocery-store.ts'), food);
		await writeFile(join(tempRepo, 'core/src/services/router/index.ts'), coreSrc);
		await writeFile(join(tempRepo, 'core/src/__tests__/router.test.ts'), coreTest);
		await writeFile(join(tempRepo, 'case.ts'), 'export {}\n');
	}

	function keyArgs(bucket: 'agent' | 'chatbot', caseId: string) {
		return {
			casePath: 'case.ts',
			coveragePaths: [] as string[],
			modelIds,
			repoRoot: tempRepo,
			caseId,
			harnessPaths: BUCKET_HARNESS_PATHS[bucket]!,
		};
	}

	it('SUT_APP_IDS equals the apps that have src/ and a manifest', () => {
		expect([...SUT_APP_IDS].sort()).toEqual(appsWithSrcAndManifest(REPO_ROOT));
	});

	it('chatbot and agent buckets list core/src and every app src plus its manifest', () => {
		const appIds = appsWithSrcAndManifest(REPO_ROOT);
		expect(appIds.length).toBeGreaterThan(0);
		for (const bucket of ['chatbot', 'agent'] as const) {
			const paths = BUCKET_HARNESS_PATHS[bucket]!;
			expect(paths, bucket).toContain('core/src/');
			for (const id of appIds) {
				expect(paths, bucket).toContain(`apps/${id}/src/`);
				expect(paths, bucket).toContain(`apps/${id}/manifest.yaml`);
			}
		}
	});

	it('expands system-under-test sources into the agent and chatbot keys and skips __tests__', async () => {
		for (const bucket of ['agent', 'chatbot'] as const) {
			const files = await expandHarnessPaths(BUCKET_HARNESS_PATHS[bucket]!, REPO_ROOT);
			expect(files, bucket).toContain('apps/food/src/services/grocery-store.ts');
			expect(files, bucket).toContain('core/src/services/router/index.ts');
			expect(
				files.some((f) => f.includes('/__tests__/')),
				bucket,
			).toBe(false);
		}
	});

	it('editing a file under apps/food/src changes the agent key and the chatbot key', async () => {
		await writeSut('food-v1\n', 'core-v1\n', 'test-v1\n');
		const beforeAgent = await computeCacheKey(keyArgs('agent', 'a'));
		const beforeChat = await computeCacheKey(keyArgs('chatbot', 'c'));
		await writeFile(join(tempRepo, 'apps/food/src/services/grocery-store.ts'), 'food-v2\n');
		clearHarnessDigestCache();
		const afterAgent = await computeCacheKey(keyArgs('agent', 'a'));
		const afterChat = await computeCacheKey(keyArgs('chatbot', 'c'));
		expect(afterAgent).not.toBe(beforeAgent);
		expect(afterChat).not.toBe(beforeChat);
	});

	it('editing a file under core/src changes the agent key and the chatbot key', async () => {
		await writeSut('food-v1\n', 'core-v1\n', 'test-v1\n');
		const beforeAgent = await computeCacheKey(keyArgs('agent', 'a'));
		const beforeChat = await computeCacheKey(keyArgs('chatbot', 'c'));
		await writeFile(join(tempRepo, 'core/src/services/router/index.ts'), 'core-v2\n');
		clearHarnessDigestCache();
		const afterAgent = await computeCacheKey(keyArgs('agent', 'a'));
		const afterChat = await computeCacheKey(keyArgs('chatbot', 'c'));
		expect(afterAgent).not.toBe(beforeAgent);
		expect(afterChat).not.toBe(beforeChat);
	});

	it('editing a __tests__ file under core/src does not change the agent or chatbot key', async () => {
		await writeSut('food-v1\n', 'core-v1\n', 'test-v1\n');
		const beforeAgent = await computeCacheKey(keyArgs('agent', 'a'));
		const beforeChat = await computeCacheKey(keyArgs('chatbot', 'c'));
		await writeFile(join(tempRepo, 'core/src/__tests__/router.test.ts'), 'test-v2\n');
		clearHarnessDigestCache();
		const afterAgent = await computeCacheKey(keyArgs('agent', 'a'));
		const afterChat = await computeCacheKey(keyArgs('chatbot', 'c'));
		expect(afterAgent).toBe(beforeAgent);
		expect(afterChat).toBe(beforeChat);
	});

	it('hashes the harness digest once for N cases that share a bucket and repo', async () => {
		clearHarnessDigestCache();
		await mkdir(join(tempRepo, 'apps/food/src'), { recursive: true });
		await writeFile(join(tempRepo, 'apps/food/src/grocery-store.ts'), 'v1\n');
		await writeFile(join(tempRepo, 'case.ts'), 'export {}\n');
		const harnessPaths = ['apps/food/src/'] as const;
		const cases = ['a', 'b', 'c', 'd', 'e'];
		await Promise.all(
			cases.map((caseId) =>
				computeCacheKey({
					casePath: 'case.ts',
					coveragePaths: [],
					modelIds,
					repoRoot: tempRepo,
					caseId,
					harnessPaths,
				}),
			),
		);
		expect(harnessDigestComputeCount()).toBe(1);
	});
});

describe('computeCacheKey — provider identity and behavioural config (review R2-1)', () => {
	const modelIds = { fast: 'gemma', standard: 'gemma', reasoning: null as string | null };

	async function baseArgs() {
		await writeFile(join(tempRepo, 'case.ts'), 'export {}\n');
		return {
			casePath: 'case.ts',
			coveragePaths: [] as string[],
			modelIds,
			repoRoot: tempRepo,
			caseId: 'case-1',
		};
	}

	function refs(fastProvider: string, standardProvider = fastProvider) {
		return {
			fast: { provider: fastProvider, model: 'gemma' },
			standard: { provider: standardProvider, model: 'gemma' },
			reasoning: null,
		};
	}

	it('same model string with a different provider produces a different key', async () => {
		const base = await baseArgs();
		const ollama = await computeCacheKey({ ...base, tierRefs: refs('ollama') });
		const llamaCpp = await computeCacheKey({ ...base, tierRefs: refs('llama-cpp') });
		expect(llamaCpp).not.toBe(ollama);
	});

	it('the same provider/model produces the same key', async () => {
		const base = await baseArgs();
		const first = await computeCacheKey({ ...base, tierRefs: refs('ollama', 'llama-cpp') });
		const second = await computeCacheKey({ ...base, tierRefs: refs('ollama', 'llama-cpp') });
		expect(second).toBe(first);
	});

	it('changing one byte of the config changes the key, and a missing config is stable', async () => {
		const base = await baseArgs();
		const configPath = join(tempRepo, 'pas.yaml');
		await writeFile(configPath, 'routing:\n  multi_intent_split: true\n');
		const chatBefore = await computeCacheKey({ ...base, caseId: 'chat', configPath });
		const agentBefore = await computeCacheKey({ ...base, caseId: 'agent', configPath });
		await writeFile(configPath, 'routing:\n  multi_intent_split: fals\n');
		const chatAfter = await computeCacheKey({ ...base, caseId: 'chat', configPath });
		const agentAfter = await computeCacheKey({ ...base, caseId: 'agent', configPath });
		expect(chatAfter).not.toBe(chatBefore);
		expect(agentAfter).not.toBe(agentBefore);

		const missing = join(tempRepo, 'missing-pas.yaml');
		const absentA = await computeCacheKey({ ...base, caseId: 'chat', configPath: missing });
		const absentB = await computeCacheKey({ ...base, caseId: 'chat', configPath: missing });
		const absentOtherPath = await computeCacheKey({
			...base,
			caseId: 'chat',
			configPath: join(tempRepo, 'also-missing.yaml'),
		});
		expect(absentA).toBe(absentB);
		expect(absentOtherPath).toBe(absentA);
		expect(absentA).not.toBe(chatBefore);
	});
});
