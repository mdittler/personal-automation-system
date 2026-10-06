import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	BUCKET_HARNESS_PATHS,
	EXECUTION_CLOSURE_ENV_VARS,
	clearHarnessDigestCache,
	computeCacheKey,
	executionClosureComputeCount,
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
	// git leaves .git busy for a moment; macOS rm can report ENOTEMPTY mid-delete.
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await rm(tempRepo, { recursive: true, force: true });
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 4) throw err;
			await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
		}
	}
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

	it('hashes the harness digest once for N cases that share a bucket and repo', async () => {
		clearHarnessDigestCache();
		await mkdir(join(tempRepo, 'apps/food/src'), { recursive: true });
		await writeFile(join(tempRepo, 'apps/food/src/grocery-store.ts'), 'v1\n');
		await writeFile(join(tempRepo, 'case.ts'), 'export {}\n');
		const harnessPaths = ['apps/food/src/'] as const;
		const modelIds = { fast: 'f', standard: 's', reasoning: null as string | null };
		await Promise.all(
			['a', 'b', 'c', 'd', 'e'].map((caseId) =>
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

describe('EXECUTION_CLOSURE_ENV_VARS', () => {
	it('lists behaviour-changing vars and no secret-shaped names', () => {
		expect(EXECUTION_CLOSURE_ENV_VARS).toContain('OLLAMA_URL');
		expect(EXECUTION_CLOSURE_ENV_VARS.length).toBeGreaterThan(0);
		for (const name of EXECUTION_CLOSURE_ENV_VARS) {
			expect(name, name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i);
		}
	});
});

describe('computeCacheKey — execution closure (chatbot and agent)', () => {
	const modelIds = { fast: 'f', standard: 's', reasoning: null as string | null };

	function commitAll(message: string): void {
		execSync(`git add -A && git commit -q -m ${JSON.stringify(message)}`, { cwd: tempRepo });
	}

	async function seedCase(): Promise<void> {
		await writeFile(join(tempRepo, 'case.ts'), 'export {}\n');
		commitAll('init');
	}

	function closureArgs(
		bucket: 'chatbot' | 'agent',
		extra: Record<string, unknown> = {},
	): Parameters<typeof computeCacheKey>[0] {
		return {
			casePath: 'case.ts',
			coveragePaths: [],
			modelIds,
			repoRoot: tempRepo,
			caseId: bucket,
			bucket,
			timezone: 'UTC',
			...extra,
		};
	}

	async function bothKeys(extra: Record<string, unknown> = {}): Promise<{
		chatbot: string;
		agent: string;
	}> {
		return {
			chatbot: await computeCacheKey(closureArgs('chatbot', extra)),
			agent: await computeCacheKey(closureArgs('agent', extra)),
		};
	}

	async function withEnv<T>(
		name: string,
		value: string | undefined,
		fn: () => Promise<T>,
	): Promise<T> {
		const prev = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		try {
			return await fn();
		} finally {
			if (prev === undefined) delete process.env[name];
			else process.env[name] = prev;
		}
	}

	it('a tracked-file edit changes the chatbot key and the agent key', async () => {
		await seedCase();
		await mkdir(join(tempRepo, 'core/src'), { recursive: true });
		await writeFile(join(tempRepo, 'core/src/live.ts'), 'v1\n');
		commitAll('live');
		const before = await bothKeys();
		await writeFile(join(tempRepo, 'core/src/live.ts'), 'v2\n');
		clearHarnessDigestCache();
		const after = await bothKeys();
		expect(after.chatbot).not.toBe(before.chatbot);
		expect(after.agent).not.toBe(before.agent);
	});

	it('a new untracked file changes the chatbot key and the agent key', async () => {
		await seedCase();
		const before = await bothKeys();
		await mkdir(join(tempRepo, 'src'), { recursive: true });
		await writeFile(join(tempRepo, 'src/extra.ts'), 'new\n');
		clearHarnessDigestCache();
		const after = await bothKeys();
		expect(after.chatbot).not.toBe(before.chatbot);
		expect(after.agent).not.toBe(before.agent);
	});

	it('an edit under docs/ or a __tests__ directory does not change the chatbot or agent key', async () => {
		await seedCase();
		await mkdir(join(tempRepo, 'docs'), { recursive: true });
		await mkdir(join(tempRepo, 'core/src/__tests__'), { recursive: true });
		await writeFile(join(tempRepo, 'docs/guide.md'), 'v1\n');
		await writeFile(join(tempRepo, 'core/src/__tests__/router.test.ts'), 'v1\n');
		commitAll('docs-and-tests');
		const before = await bothKeys();
		await writeFile(join(tempRepo, 'docs/guide.md'), 'v2\n');
		await writeFile(join(tempRepo, 'core/src/__tests__/router.test.ts'), 'v2\n');
		await writeFile(join(tempRepo, 'docs/new.md'), 'untracked\n');
		await writeFile(join(tempRepo, 'core/src/__tests__/extra.test.ts'), 'untracked\n');
		clearHarnessDigestCache();
		const after = await bothKeys();
		expect(after.chatbot).toBe(before.chatbot);
		expect(after.agent).toBe(before.agent);
	});

	it('changing a byte under apps/food/dist changes the chatbot key and the agent key', async () => {
		await seedCase();
		// dist/ is gitignored in the real repo, so the worktree identity does not
		// see these bytes. The closure has to read them from disk.
		await writeFile(join(tempRepo, '.gitignore'), 'dist/\n');
		commitAll('ignore-dist');
		await mkdir(join(tempRepo, 'apps/food/dist'), { recursive: true });
		await writeFile(join(tempRepo, 'apps/food/dist/index.js'), 'v1\n');
		const before = await bothKeys();
		await writeFile(join(tempRepo, 'apps/food/dist/index.js'), 'v2\n');
		clearHarnessDigestCache();
		const after = await bothKeys();
		expect(after.chatbot).not.toBe(before.chatbot);
		expect(after.agent).not.toBe(before.agent);
	});

	it('a missing dist directory is a stable marker, distinct from an empty dist', async () => {
		await seedCase();
		await mkdir(join(tempRepo, 'apps/food'), { recursive: true });
		const first = await bothKeys();
		clearHarnessDigestCache();
		const second = await bothKeys();
		expect(second.chatbot).toBe(first.chatbot);
		expect(second.agent).toBe(first.agent);
		await mkdir(join(tempRepo, 'apps/food/dist'), { recursive: true });
		clearHarnessDigestCache();
		const empty = await bothKeys();
		expect(empty.chatbot).not.toBe(first.chatbot);
		expect(empty.agent).not.toBe(first.agent);
	});

	it('changing an allow-listed env var changes the chatbot key and the agent key', async () => {
		await seedCase();
		const before = await withEnv('OLLAMA_URL', 'http://127.0.0.1:11434', () => bothKeys());
		clearHarnessDigestCache();
		const after = await withEnv('OLLAMA_URL', 'http://127.0.0.1:11435', () => bothKeys());
		expect(after.chatbot).not.toBe(before.chatbot);
		expect(after.agent).not.toBe(before.agent);
	});

	it('changing ANTHROPIC_API_KEY does not change the chatbot or agent key', async () => {
		await seedCase();
		const before = await withEnv('ANTHROPIC_API_KEY', 'sk-one', () => bothKeys());
		const after = await withEnv('ANTHROPIC_API_KEY', 'sk-two', () => bothKeys());
		expect(after.chatbot).toBe(before.chatbot);
		expect(after.agent).toBe(before.agent);
	});

	it('changing the judge ref changes the chatbot key', async () => {
		await seedCase();
		const first = await computeCacheKey(
			closureArgs('chatbot', { judgeRef: { provider: 'ollama', model: 'gemma-a' } }),
		);
		const second = await computeCacheKey(
			closureArgs('chatbot', { judgeRef: { provider: 'ollama', model: 'gemma-b' } }),
		);
		expect(second).not.toBe(first);
	});

	it('the agent key changes when the injected clock crosses a local date', async () => {
		await seedCase();
		const day1 = new Date('2026-04-01T12:00:00Z');
		const day2 = new Date('2026-04-02T12:00:00Z');
		const first = await computeCacheKey(closureArgs('agent', { now: day1, timezone: 'UTC' }));
		const second = await computeCacheKey(closureArgs('agent', { now: day2, timezone: 'UTC' }));
		expect(second).not.toBe(first);
		const chatDay1 = await computeCacheKey(closureArgs('chatbot', { now: day1, timezone: 'UTC' }));
		const chatDay2 = await computeCacheKey(closureArgs('chatbot', { now: day2, timezone: 'UTC' }));
		expect(chatDay2).toBe(chatDay1);
	});

	it('the agent key changes when the timezone changes for the same instant', async () => {
		await seedCase();
		// 03:30Z is still the 14th in New York and already the 15th in UTC.
		const now = new Date('2026-01-15T03:30:00Z');
		const utc = await computeCacheKey(closureArgs('agent', { now, timezone: 'UTC' }));
		const ny = await computeCacheKey(closureArgs('agent', { now, timezone: 'America/New_York' }));
		expect(ny).not.toBe(utc);
	});

	it('a core edit does not change the routing key and does change the chatbot key', async () => {
		await seedCase();
		await mkdir(join(tempRepo, 'core/src/services'), { recursive: true });
		await writeFile(join(tempRepo, 'core/src/services/unrelated.ts'), 'v1\n');
		commitAll('core');
		const routingArgs = {
			casePath: 'case.ts',
			coveragePaths: [] as string[],
			modelIds,
			repoRoot: tempRepo,
			caseId: 'route',
			bucket: 'routing' as const,
			harnessPaths: BUCKET_HARNESS_PATHS.routing,
		};
		const routingBefore = await computeCacheKey(routingArgs);
		const chatBefore = await computeCacheKey(closureArgs('chatbot'));
		await writeFile(join(tempRepo, 'core/src/services/unrelated.ts'), 'v2\n');
		clearHarnessDigestCache();
		const routingAfter = await computeCacheKey(routingArgs);
		const chatAfter = await computeCacheKey(closureArgs('chatbot'));
		expect(routingAfter).toBe(routingBefore);
		expect(chatAfter).not.toBe(chatBefore);
	});

	it('hashes the worktree and app dist once for many chatbot and agent cases', async () => {
		clearHarnessDigestCache();
		await seedCase();
		await Promise.all(
			['a', 'b', 'c', 'd', 'e'].flatMap((id) =>
				(['chatbot', 'agent'] as const).map((bucket) =>
					computeCacheKey({ ...closureArgs(bucket), caseId: id }),
				),
			),
		);
		expect(executionClosureComputeCount()).toBe(1);
	});
});
