import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { PersonaCase } from '@core/types/regression.js';
import { hashRepoRelative } from './git-hash.js';
import type { TierModelSnapshot } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Today as YYYY-MM-DD in the supplied timezone. `now` defaults to the current
 * instant; tests inject a clock for the agent execution-closure date. Shared
 * between the cache key, the receipt-runner's date-fallback assertion, and
 * `buildRecallAdapter`'s default `today`. Exported so the regression workspace
 * doesn't have three byte-identical copies drifting.
 */
export function todayInTimezone(tz: string, now: Date = new Date()): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return fmt.format(now);
}

/**
 * Bucket-specific cache-key salts. Today only the `receipt` bucket uses a
 * salt — it binds the cache to today's date + timezone so the parser's
 * `isValidReceiptDate` rejection branch (which depends on `today`) re-runs
 * after a date rollover. Returning `undefined` means no salt is mixed in.
 * The agent bucket's date binding lives in the execution closure, not here.
 *
 * Both `runSuite()` and `emitCaseList()` call this so cache-key parity holds
 * between `--list` (used by the GUI for the "currently-cached?" indicator)
 * and the actual run.
 */
export function bucketCacheSalt(
	bucket: PersonaCase['bucket'],
	timezone: string,
): string | undefined {
	if (bucket === 'receipt') {
		return `today:${todayInTimezone(timezone)}:tz:${timezone}`;
	}
	return undefined;
}

/**
 * Harness sources whose behaviour shapes a narrow bucket's verdicts (REQ-REG-024).
 * Routing, recall, and receipt mix these paths into the key. Chatbot and agent
 * do not: they grade the live process, so their key is the execution closure
 * below instead of an enumerated path list. Entries ending in `/` expand to
 * every tracked or untracked (non-ignored) file below them, excluding
 * `__tests__/`. A contract test asserts each entry exists in the real repository.
 *
 * The expanded-and-hashed harness digest is memoized per path list and repo
 * root for the life of the process.
 */
export const COMMON_HARNESS_PATHS: readonly string[] = [
	'regression/src/runner/index.ts',
	'regression/src/shared/cache-key.ts',
	'core/src/services/llm/',
];

/**
 * Behaviour-changing environment variables mixed into the chatbot and agent
 * execution closure. Values are hashed; names that look like secrets are
 * rejected by a contract test.
 *
 * `core/src/services/llm` reads `process.env` only for `config.apiKeyEnvVar`
 * (a secret — excluded). Base URLs otherwise come from pas.yaml. The allow-list
 * is the config-layer overrides that change which server or model runs, plus
 * the SDK base-URL fallbacks the providers leave unset: `AnthropicProvider`
 * does not pass `baseURL` (the SDK reads `ANTHROPIC_BASE_URL`), and
 * `OpenAICompatibleProvider` passes `baseUrl` through, which is `undefined`
 * when pas.yaml omits it (the SDK then reads `OPENAI_BASE_URL`). There is no
 * thinking env flag; `LLMCompletionOptions.thinking` defaults off in code.
 */
export const EXECUTION_CLOSURE_ENV_VARS = [
	'ANTHROPIC_BASE_URL',
	'CLAUDE_FAST_MODEL',
	'CLAUDE_MODEL',
	'OLLAMA_MODEL',
	'OLLAMA_URL',
	'OPENAI_BASE_URL',
] as const;

const EXECUTION_CLOSURE_BUCKETS: ReadonlySet<string> = new Set(['chatbot', 'agent']);

/** Chatbot and agent keys use the execution closure instead of harness paths. */
export function usesExecutionClosure(bucket: string | undefined): boolean {
	return bucket !== undefined && EXECUTION_CLOSURE_BUCKETS.has(bucket);
}

export const BUCKET_HARNESS_PATHS: Readonly<Record<string, readonly string[]>> = {
	routing: [
		...COMMON_HARNESS_PATHS,
		'regression/src/runner/case-runners/routing-runner.ts',
		'regression/src/runner/dispatch.ts',
		'regression/src/oracles/structural.ts',
	],
	recall: [
		...COMMON_HARNESS_PATHS,
		'regression/src/runner/case-runners/recall-runner.ts',
		'regression/src/runner/dispatch.ts',
		'regression/src/oracles/structural.ts',
	],
	receipt: [
		...COMMON_HARNESS_PATHS,
		'regression/src/runner/case-runners/receipt-runner.ts',
		'regression/src/oracles/structural.ts',
		'regression/src/oracles/transcription.ts',
	],
};

/** Expand `dir/` entries into sorted file lists (tracked + untracked, non-ignored). */
export async function expandHarnessPaths(
	paths: readonly string[],
	repoRoot: string,
): Promise<string[]> {
	const out = new Set<string>();
	for (const p of paths) {
		if (!p.endsWith('/')) {
			out.add(p);
			continue;
		}
		const { stdout } = await execFileAsync(
			'git',
			['ls-files', '--cached', '--others', '--exclude-standard', '--', p],
			{ cwd: repoRoot },
		);
		for (const f of stdout.split('\n')) {
			if (f && !f.includes('/__tests__/')) out.add(f);
		}
	}
	return [...out].sort();
}

/**
 * How many times this process actually expanded and hashed a harness path
 * list. Cache hits do not increment. Tests reset via `clearHarnessDigestCache`.
 */
let harnessDigestComputes = 0;
const harnessDigestCache = new Map<string, Promise<string>>();

/** Worktree + dist identity computations. Cache hits do not increment. */
let executionClosureComputes = 0;
const executionClosureCache = new Map<string, Promise<ExecutionClosureIdentity>>();

export function harnessDigestComputeCount(): number {
	return harnessDigestComputes;
}

/**
 * Drop the per-process harness digest and execution-closure memos.
 * A new regression run is a new process; tests call this between mutations.
 */
export function clearHarnessDigestCache(): void {
	harnessDigestCache.clear();
	harnessDigestComputes = 0;
	executionClosureCache.clear();
	executionClosureComputes = 0;
}

async function memoizedHarnessDigest(
	paths: readonly string[],
	repoRoot: string,
	hash: (p: string) => Promise<string>,
): Promise<string> {
	const key = `${repoRoot}\0${paths.join('\0')}`;
	const cached = harnessDigestCache.get(key);
	if (cached) return cached;
	harnessDigestComputes += 1;
	const pending = (async () => {
		const files = await expandHarnessPaths(paths, repoRoot);
		const entries = await Promise.all(
			files.map(async (p) => {
				try {
					return `${p}:${await hash(p)}`;
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `${p}:absent`;
					throw err;
				}
			}),
		);
		return entries.join('\n');
	})();
	harnessDigestCache.set(key, pending);
	try {
		return await pending;
	} catch (err) {
		harnessDigestCache.delete(key);
		throw err;
	}
}

interface ExecutionClosureIdentity {
	worktree: string;
	dist: string;
}

export function executionClosureComputeCount(): number {
	return executionClosureComputes;
}

const WORKTREE_DIFF_ARGS = [
	'diff',
	'HEAD',
	'--binary',
	'--',
	'.',
	':(exclude)docs',
	':(exclude)**/__tests__/**',
];

/** `docs/` and any `__tests__/` directory are not executed by a regression trial. */
function excludedFromWorktree(repoRel: string): boolean {
	const parts = repoRel.split('/');
	return parts[0] === 'docs' || parts.includes('__tests__');
}

function gitStatus(err: unknown): number | undefined {
	if (typeof err !== 'object' || err === null) return undefined;
	const code = (err as { code?: unknown }).code;
	if (typeof code === 'number') return code;
	const status = (err as { status?: unknown }).status;
	return typeof status === 'number' ? status : undefined;
}

function stderrOf(err: unknown): string {
	if (typeof err !== 'object' || err === null) return '';
	const stderr = (err as { stderr?: unknown }).stderr;
	if (typeof stderr === 'string') return stderr;
	if (Buffer.isBuffer(stderr)) return stderr.toString('utf8');
	return '';
}

function isUnbornHead(err: unknown): boolean {
	return gitStatus(err) === 128 && /HEAD|unknown revision|bad revision/i.test(stderrOf(err));
}

async function gitHead(repoRoot: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
		return stdout.trim();
	} catch (err) {
		if (isUnbornHead(err)) return 'absent';
		throw err;
	}
}

/** SHA-256 of `git diff HEAD --binary`, excluding docs and tests. Empty when HEAD is unborn. */
function gitDiffHash(repoRoot: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', WORKTREE_DIFF_ARGS, {
			cwd: repoRoot,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		if (!child.stdout || !child.stderr) {
			reject(new Error('git diff spawned without pipes'));
			return;
		}
		const hash = createHash('sha256');
		const stderr: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => {
			hash.update(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr.push(chunk);
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve(hash.digest('hex'));
				return;
			}
			const message = Buffer.concat(stderr).toString('utf8');
			if (code === 128 && /HEAD|unknown revision|bad revision/i.test(message)) {
				resolve(createHash('sha256').update('').digest('hex'));
				return;
			}
			reject(new Error(`git diff HEAD failed (${code}): ${message.trim()}`));
		});
	});
}

async function untrackedIdentity(repoRoot: string): Promise<string> {
	const { stdout } = await execFileAsync(
		'git',
		['ls-files', '-z', '--others', '--exclude-standard'],
		{ cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
	);
	const paths = stdout
		.split('\0')
		.filter((p) => p.length > 0 && !excludedFromWorktree(p))
		.sort();
	const lines = await Promise.all(
		paths.map(async (p) => {
			const bytes = await readFile(join(repoRoot, p));
			return `${p}:${createHash('sha256').update(bytes).digest('hex')}`;
		}),
	);
	return lines.join('\n');
}

async function worktreeIdentity(repoRoot: string): Promise<string> {
	const [head, diffHash, untracked] = await Promise.all([
		gitHead(repoRoot),
		gitDiffHash(repoRoot),
		untrackedIdentity(repoRoot),
	]);
	return `head:${head}\ndiff:${diffHash}\nuntracked:\n${untracked}`;
}

async function walkFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walkFiles(abs)));
		else if (entry.isFile()) out.push(abs);
	}
	return out;
}

/** `dist:<sha256 of sorted path+content>` or `dist:absent`. */
async function distMarker(distDir: string): Promise<string> {
	let files: string[];
	try {
		files = await walkFiles(distDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'dist:absent';
		throw err;
	}
	const rels = files.map((abs) => relative(distDir, abs).split(sep).join('/')).sort();
	const hash = createHash('sha256');
	for (const rel of rels) {
		hash.update(rel);
		hash.update('\0');
		hash.update(await readFile(join(distDir, rel)));
		hash.update('\0');
	}
	return `dist:${hash.digest('hex')}`;
}

/** Every `apps/<id>` on disk. A missing `dist/` contributes `dist:absent`. */
async function appDistIdentity(repoRoot: string): Promise<string> {
	const appsDir = join(repoRoot, 'apps');
	let entries: Dirent[];
	try {
		entries = await readdir(appsDir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'apps:absent';
		throw err;
	}
	const ids = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const lines = await Promise.all(
		ids.map(async (id) => `apps/${id}/${await distMarker(join(appsDir, id, 'dist'))}`),
	);
	return lines.join('\n');
}

async function memoizedExecutionClosure(repoRoot: string): Promise<ExecutionClosureIdentity> {
	const cached = executionClosureCache.get(repoRoot);
	if (cached) return cached;
	executionClosureComputes += 1;
	const pending = (async () => ({
		worktree: await worktreeIdentity(repoRoot),
		dist: await appDistIdentity(repoRoot),
	}))();
	executionClosureCache.set(repoRoot, pending);
	try {
		return await pending;
	} catch (err) {
		executionClosureCache.delete(repoRoot);
		throw err;
	}
}

function envClosureMarker(env: NodeJS.ProcessEnv): string {
	return EXECUTION_CLOSURE_ENV_VARS.map((name) => {
		const value = env[name];
		return value === undefined ? `${name}:unset` : `${name}=${value}`;
	}).join('\n');
}

function judgeMarker(ref: { provider: string; model: string } | null | undefined): string {
	if (!ref) return 'judge:absent';
	return `judge:${ref.provider}/${ref.model}`;
}

/** Env, runtime, judge, repeats, and (agent) today's date. Not memoized. */
function executionClosureTail(args: ComputeCacheKeyArgs): string {
	const lines = [
		envClosureMarker(process.env),
		`node:${process.version}`,
		`platform:${process.platform}`,
		`arch:${process.arch}`,
	];
	if (args.bucket === 'chatbot') lines.push(judgeMarker(args.judgeRef));
	if (args.bucket === 'agent') {
		const tz = args.timezone && args.timezone.length > 0 ? args.timezone : 'UTC';
		lines.push(`repeats:${args.repeats ?? 3}`);
		lines.push(`today:${todayInTimezone(tz, args.now)}:tz:${tz}`);
	}
	return lines.join('\n');
}

async function executionClosureMaterial(args: ComputeCacheKeyArgs): Promise<string> {
	const identity = await memoizedExecutionClosure(args.repoRoot);
	return `${identity.worktree}\n${identity.dist}\n${executionClosureTail(args)}`;
}

/**
 * Resolved provider + model for each tier. The cache key uses `provider/model`
 * so two backends serving the same model string do not share a grade.
 * `modelIds` stays the display snapshot (model strings only).
 */
export interface TierCacheRefs {
	fast: { provider: string; model: string } | null;
	standard: { provider: string; model: string } | null;
	reasoning: { provider: string; model: string } | null;
}

export interface ComputeCacheKeyArgs {
	casePath: string; // repo-relative
	coveragePaths: string[]; // all repo-relative
	modelIds: TierModelSnapshot;
	/**
	 * Resolved refs the trial actually runs. When set, each tier is keyed as
	 * `provider/model` (a null slot falls back to the `modelIds` string).
	 */
	tierRefs?: TierCacheRefs;
	/**
	 * Behavioural config the chatbot and agent runtimes load (`pas.yaml`).
	 * Callers pass the path actually used for the run, and only for those
	 * buckets. The file's bytes are hashed; a missing file contributes
	 * `config:absent`.
	 */
	configPath?: string;
	repoRoot: string;
	/**
	 * Optional memo of `repoRelativePath → Promise<hash>`. Pass a shared `Map`
	 * across many `computeCacheKey` calls within one orchestrator invocation
	 * to coalesce repeated `git hash-object` spawns for shared coverage paths.
	 * Map values are promises so concurrent callers awaiting the same path
	 * still only pay the cost once.
	 */
	hashCache?: Map<string, Promise<string>>;
	/**
	 * Optional bucket-specific salt mixed into the hash before model/coverage
	 * components. Used by the receipt bucket to bind cache keys to today's
	 * date + timezone — same-day reruns still hit cache, but date rollover
	 * invalidates so the date-fallback branch (`isValidReceiptDate` →
	 * `rawExtractedDate`) re-exercises. Omitted for routing, recall, chatbot,
	 * and agent (the agent date binding is part of the execution closure).
	 */
	extraSalt?: string;
	/** Case id — distinguishes cases that share one definition file. */
	caseId?: string;
	/**
	 * Harness sources (see `BUCKET_HARNESS_PATHS`). Unlike `coveragePaths`, a
	 * missing harness file contributes `path:absent` instead of throwing, so
	 * temp-repo unit tests need not recreate the real harness tree.
	 * Ignored when `bucket` is `chatbot` or `agent` — those use the execution
	 * closure instead.
	 */
	harnessPaths?: readonly string[];
	/**
	 * Bucket this key is for. `chatbot` and `agent` mix in the execution
	 * closure. Routing, recall, and receipt keep `harnessPaths`.
	 */
	bucket?: PersonaCase['bucket'];
	/**
	 * Rubric judge the chatbot bucket actually calls. Hashed for `chatbot`
	 * only; a missing ref contributes `judge:absent`.
	 */
	judgeRef?: { provider: string; model: string } | null;
	/** Agent trials per task. Hashed for the `agent` bucket. Defaults to 3. */
	repeats?: number;
	/**
	 * Clock for the agent date binding. Defaults to `new Date()`. Tests inject
	 * a fixed instant so `{date:±N}` expansion is deterministic.
	 */
	now?: Date;
	/**
	 * IANA timezone for the agent date binding. Defaults to `UTC`, matching
	 * the runner when no timezone is configured.
	 */
	timezone?: string;
}

export async function computeCacheKey(args: ComputeCacheKeyArgs): Promise<string> {
	const hash = (p: string): Promise<string> => {
		if (!args.hashCache) return hashRepoRelative(p, { repoRoot: args.repoRoot });
		const existing = args.hashCache.get(p);
		if (existing) return existing;
		const pending = hashRepoRelative(p, { repoRoot: args.repoRoot });
		args.hashCache.set(p, pending);
		return pending;
	};
	const caseHash = await hash(args.casePath);
	const sortedCoverage = [...args.coveragePaths].sort();
	const hashes = await Promise.all(sortedCoverage.map(hash));
	const coverageEntries = sortedCoverage.map((p, i) => `${p}:${hashes[i]}`);

	const closure = usesExecutionClosure(args.bucket);
	const harnessJoined =
		!closure && args.harnessPaths
			? await memoizedHarnessDigest(args.harnessPaths, args.repoRoot, hash)
			: '';
	const closureJoined = closure ? await executionClosureMaterial(args) : '';

	const modelStr = args.tierRefs
		? `fast=${tierToken(args.tierRefs.fast, args.modelIds.fast, 'unknown')},standard=${tierToken(args.tierRefs.standard, args.modelIds.standard, 'unknown')},reasoning=${tierToken(args.tierRefs.reasoning, args.modelIds.reasoning, 'none')}`
		: `fast=${args.modelIds.fast},standard=${args.modelIds.standard},reasoning=${args.modelIds.reasoning ?? 'none'}`;
	const configMarker =
		args.configPath !== undefined ? await configKeyMarker(args.configPath) : undefined;

	const h = createHash('sha256');
	h.update(caseHash);
	h.update('\0');
	h.update(coverageEntries.join('\n'));
	h.update('\0');
	h.update(modelStr);
	if (args.caseId !== undefined) {
		h.update('\0');
		h.update(`case:${args.caseId}`);
	}
	if (harnessJoined.length > 0) {
		h.update('\0');
		h.update(`harness:${harnessJoined}`);
	}
	if (closureJoined.length > 0) {
		h.update('\0');
		h.update(`closure:${closureJoined}`);
	}
	if (configMarker !== undefined) {
		h.update('\0');
		h.update(configMarker);
	}
	// Salt is mixed in last with a distinguishing prefix. `extraSalt` omitted
	// vs `extraSalt: ''` yields different keys (defensive: empty string is a
	// real value, not "unsalted").
	if (args.extraSalt !== undefined) {
		h.update('\0');
		h.update('salt:');
		h.update(args.extraSalt);
	}
	return h.digest('hex');
}

function tierToken(
	ref: { provider: string; model: string } | null,
	modelId: string | null,
	missing: string,
): string {
	if (ref) return `${ref.provider}/${ref.model}`;
	return modelId ?? missing;
}

/** SHA-256 of the config bytes, or the stable `config:absent` marker. */
async function configKeyMarker(configPath: string): Promise<string> {
	try {
		const bytes = await readFile(configPath);
		return `config:${createHash('sha256').update(bytes).digest('hex')}`;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'config:absent';
		throw err;
	}
}
