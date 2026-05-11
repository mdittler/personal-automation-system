/**
 * Discover persona-regression cases by spawning the CLI in `--list` mode
 * and parsing its NDJSON output.
 *
 * **Codex C4 — no TTL on `currentCacheKey`:** every page load gets a
 * fresh subprocess invocation so coverage-file changes and model-id
 * changes are picked up immediately. In-flight requests ARE coalesced
 * to deduplicate concurrent calls, but past results are never cached.
 *
 * **Codex I4 — fail closed:** any of:
 *   - subprocess exits non-zero
 *   - a line fails JSON.parse
 *   - a `case-list-entry` line is missing required fields
 *   - the terminator `{type:'case-list-end'}` is never received
 * → `discover()` returns `{error: <message>, cases: []}`. The route
 * renders an error banner and disables Run controls.
 *
 * Skip-and-warn behaviour is reserved for the *run-mode* event stream
 * (subprocess.ts). List mode must be authoritative.
 */

import type { ChildProcessByStdio } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { TierModelSnapshot } from '../../../types/regression.js';

export interface ListedCase {
	caseId: string;
	bucket: 'routing' | 'receipt' | 'chatbot' | 'recall';
	routingTarget?: 'food-shadow' | 'session-control' | 'pas';
	description: string;
	oracle: string;
	coverage: string[];
	inputs: Array<{ payload: unknown; expected: unknown; label?: string }>;
	budgetUsd: number;
	currentCacheKey: string;
}

export interface DiscoveryResult {
	cases: ListedCase[];
	modelIds?: TierModelSnapshot;
	totalCases?: number;
	error?: string;
}

type SpawnProcLike = Pick<
	ChildProcessByStdio<null, Readable, Readable>,
	'stdout' | 'stderr' | 'on' | 'kill' | 'pid'
>;

export type SpawnFn = () => SpawnProcLike;

export interface CaseDiscoveryOptions {
	/** Override for tests; defaults to a real CLI spawn. */
	spawnFn?: SpawnFn;
	/** Required when using the default spawnFn — absolute path to `cli-main.ts`. */
	cliPath?: string;
	/** Working directory for the subprocess (repo root). */
	cwd?: string;
	/** Path to `regression/tsconfig.json` — set via `TSX_TSCONFIG_PATH` env. */
	tsconfigPath?: string;
}

export interface CaseDiscoveryService {
	discover(): Promise<DiscoveryResult>;
}

function defaultSpawn(options: CaseDiscoveryOptions): SpawnProcLike {
	if (!options.cliPath) {
		throw new Error('case-discovery: cliPath is required when no spawnFn override is set');
	}
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (options.tsconfigPath) env.TSX_TSCONFIG_PATH = options.tsconfigPath;
	return nodeSpawn(process.execPath, ['--import=tsx/esm', options.cliPath, '--list', '--json'], {
		cwd: options.cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	}) as unknown as SpawnProcLike;
}

interface RawCaseEntry {
	type?: string;
	caseId?: unknown;
	bucket?: unknown;
	routingTarget?: unknown;
	description?: unknown;
	oracle?: unknown;
	coverage?: unknown;
	inputs?: unknown;
	budgetUsd?: unknown;
	currentCacheKey?: unknown;
}

const VALID_BUCKETS = new Set(['routing', 'receipt', 'chatbot', 'recall']);
const HEX64 = /^[a-f0-9]{64}$/i;

function validateEntry(raw: RawCaseEntry): ListedCase | string {
	if (typeof raw.caseId !== 'string') return 'caseId missing';
	if (typeof raw.bucket !== 'string' || !VALID_BUCKETS.has(raw.bucket))
		return `bucket invalid: ${String(raw.bucket)}`;
	if (typeof raw.description !== 'string') return 'description missing';
	if (typeof raw.oracle !== 'string') return 'oracle missing';
	if (!Array.isArray(raw.coverage) || raw.coverage.some((c) => typeof c !== 'string'))
		return 'coverage missing or not string[]';
	if (!Array.isArray(raw.inputs)) return 'inputs missing or not array';
	if (typeof raw.budgetUsd !== 'number' || !Number.isFinite(raw.budgetUsd))
		return 'budgetUsd missing or not finite';
	if (typeof raw.currentCacheKey !== 'string' || !HEX64.test(raw.currentCacheKey))
		return 'currentCacheKey missing or invalid';
	const entry: ListedCase = {
		caseId: raw.caseId,
		bucket: raw.bucket as ListedCase['bucket'],
		description: raw.description,
		oracle: raw.oracle,
		coverage: raw.coverage as string[],
		inputs: raw.inputs as ListedCase['inputs'],
		budgetUsd: raw.budgetUsd,
		currentCacheKey: raw.currentCacheKey,
	};
	if (typeof raw.routingTarget === 'string') {
		entry.routingTarget = raw.routingTarget as ListedCase['routingTarget'];
	}
	return entry;
}

async function runOnce(spawnFn: SpawnFn): Promise<DiscoveryResult> {
	const proc = spawnFn();
	const cases: ListedCase[] = [];
	let modelIds: TierModelSnapshot | undefined;
	let totalCases: number | undefined;
	let saw_end = false;
	let parseError: string | undefined;
	let stderrTail = '';

	const reader = createInterface({ input: proc.stdout });
	proc.stderr.on('data', (chunk: Buffer | string) => {
		stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4096);
	});

	const linePromise = (async () => {
		for await (const rawLine of reader) {
			const line = rawLine.trim();
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// Non-JSON noise (e.g. dotenv's `[dotenv@x.y.z] injecting env`
				// banner that runs before the runner emits NDJSON) is silently
				// skipped. Fail-closed (Codex I4) is enforced by:
				//   1) `validateEntry` setting `parseError` on a malformed
				//      `case-list-entry` line, AND
				//   2) the missing-terminator check after the loop.
				continue;
			}
			if (typeof parsed !== 'object' || parsed === null) continue;
			const obj = parsed as Record<string, unknown>;
			const t = obj.type;
			if (t === 'case-list-entry') {
				const validated = validateEntry(obj);
				if (typeof validated === 'string') {
					parseError = `case-list-entry validation: ${validated}`;
					continue;
				}
				cases.push(validated);
			} else if (t === 'case-list-end') {
				saw_end = true;
				if (typeof obj.totalCases === 'number') totalCases = obj.totalCases;
				if (typeof obj.modelIds === 'object' && obj.modelIds !== null) {
					modelIds = obj.modelIds as TierModelSnapshot;
				}
			}
			// Unknown types (e.g. stray Pino lines) are silently skipped.
		}
	})();

	const exitPromise = new Promise<number>((resolve) => {
		proc.on('exit', (code: number | null) => resolve(code ?? 1));
	});

	await linePromise;
	const exitCode = await exitPromise;

	if (exitCode !== 0) {
		return {
			cases: [],
			error: `regression --list exited ${exitCode}${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
		};
	}
	if (parseError) {
		return { cases: [], error: parseError };
	}
	if (!saw_end) {
		return { cases: [], error: 'regression --list missing terminator (case-list-end)' };
	}
	return { cases, modelIds, totalCases };
}

export function createCaseDiscovery(options: CaseDiscoveryOptions): CaseDiscoveryService {
	const spawnFn: SpawnFn = options.spawnFn ?? (() => defaultSpawn(options));
	let inflight: Promise<DiscoveryResult> | null = null;

	return {
		async discover(): Promise<DiscoveryResult> {
			if (inflight) return inflight;
			inflight = runOnce(spawnFn).finally(() => {
				inflight = null;
			});
			return inflight;
		},
	};
}
