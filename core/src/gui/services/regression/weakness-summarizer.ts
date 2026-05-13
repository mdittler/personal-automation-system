/**
 * Per-(run, tier) weakness summarizer (REQ-REG-GUI-V2-018/019).
 *
 * Given a `RunManifest`, this service:
 *   1. Filters to one tier's fail/error results (input → expected → actual).
 *   2. Reads the failing cache files from disk to recover their full inputs +
 *      actual outputs (the manifest carries verdict + cost only — payloads
 *      live in the cache, kept slim by design).
 *   3. Sanitizes failing-case payloads via a local fence/strip pass that
 *      collapses triple-backtick fences (so user data cannot break out of
 *      the prompt's fenced block) and strips zero-width / bidi control
 *      characters that could hide hostile instructions. Functionally
 *      equivalent to `sanitizeContextContent` from `core/src/services/
 *      conversation/sanitize.ts`; kept local here so this service has no
 *      conversation-stack imports and remains independently testable.
 *   4. Calls `LLMService.complete()` at standard tier with
 *      `responseFormat: 'json'` and a one-shot empty-output retry, matching
 *      the Batch 1/2 plumbing.
 *   5. Persists the structured JSON to disk atomically.
 *
 * The persisted file is the SINGLE consumer surface for the route layer. The
 * polled `/runs/:runId/summary` route reads this file and returns 200 / 202
 * / 504 based on its presence.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { sanitizeContextContent } from '../../../services/prompt-assembly/memory-context.js';
import type { LLMService } from '../../../types/llm.js';
import type {
	EvaluatedTier,
	ManifestCaseResult,
	RunManifest,
	RunResult,
} from '../../../types/regression.js';
import { isPlainObject, looksLikeRunResult } from '../../../types/regression.js';
import { atomicWriteJson } from '../../../utils/atomic-write.js';
import { UNPARSEABLE_JSON, tryParseJsonStripFences } from '../../../utils/json-strip-fences.js';

export type SummaryTier = Exclude<EvaluatedTier, 'mixed' | 'unknown'>;

export interface FailureCategory {
	label: string;
	count: number;
	exampleCaseIds: string[];
}

export interface PersistedWeaknessSummary {
	status: 'ready' | 'error' | 'no-failures';
	runId: string;
	tier: SummaryTier;
	modelId: string;
	generatedAt: string; // ISO-8601
	hadFailures: boolean;
	failureCategories?: FailureCategory[];
	summary?: string;
	llmRawOutput?: string;
	errorMessage?: string;
}

export interface WeaknessSummarizerOptions {
	manifestDir: string;
	cacheDir: string;
	summaryDir: string;
	llm: Pick<LLMService, 'complete'>;
	logger: Logger;
	/** Truncate the failing-cases list passed to the LLM (default 20). */
	maxFailingInputs?: number;
}

export interface SummarizeRequest {
	manifest: RunManifest;
	tier: SummaryTier;
	/** `true` to overwrite an existing file. Default `false` (idempotent). */
	force?: boolean;
}

const DEFAULT_MAX_FAILING_INPUTS = 20;

const SYSTEM_PROMPT =
	`You analyze regression test failures for a personal-automation-system. Given a model's failing inputs and the actuals it produced, identify the categories of inputs where this model struggles. Return JSON only.

Schema:
{
  "summary": "<one-paragraph plain-English summary of the model's weaknesses, max 150 words>",
  "failureCategories": [
    {
      "label": "<short category label, e.g. 'mis-routes cultural recipes'>",
      "count": <integer count of failing inputs in this category>,
      "exampleCaseIds": ["<caseId>", ...]
    }
  ]
}

Rules:
- Cluster failures into 2-5 meaningful categories. Do NOT invent failures.
- If all failures share one root cause, return a single category.
- exampleCaseIds must come from the input list — never invent ids.
- Be specific: "fails on holiday-themed recipe searches" beats "fails on recipes".
- Plain ASCII only. No markdown.`;

export interface WeaknessSummarizer {
	summarize(req: SummarizeRequest): Promise<PersistedWeaknessSummary>;
	/** Resolves the on-disk path for a (runId, tier) pair. */
	pathFor(runId: string, tier: SummaryTier): string;
	/** Read a previously persisted summary; null if not yet written. */
	read(runId: string, tier: SummaryTier): Promise<PersistedWeaknessSummary | null>;
}

export function createWeaknessSummarizer(
	opts: WeaknessSummarizerOptions,
): WeaknessSummarizer {
	const { manifestDir, cacheDir, summaryDir, llm, logger } = opts;
	const maxFailing = opts.maxFailingInputs ?? DEFAULT_MAX_FAILING_INPUTS;

	function pathFor(runId: string, tier: SummaryTier): string {
		return join(summaryDir, runId, `${tier}.json`);
	}

	async function read(
		runId: string,
		tier: SummaryTier,
	): Promise<PersistedWeaknessSummary | null> {
		const path = pathFor(runId, tier);
		let buf: string;
		try {
			buf = await readFile(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			logger.warn(
				{ err: (err as Error).message, path },
				'weakness-summarizer: read failed',
			);
			return null;
		}
		try {
			const parsed = JSON.parse(buf);
			if (!isPersistedSummary(parsed)) {
				logger.warn({ path }, 'weakness-summarizer: persisted summary shape invalid');
				return null;
			}
			return parsed;
		} catch (err) {
			logger.warn(
				{ err: (err as Error).message, path },
				'weakness-summarizer: persisted summary JSON parse failed',
			);
			return null;
		}
	}

	async function summarize(req: SummarizeRequest): Promise<PersistedWeaknessSummary> {
		const { manifest, tier, force = false } = req;
		const existing = await read(manifest.runId, tier);
		if (existing && !force) return existing;

		const modelId = modelIdForTier(manifest, tier);
		const failing = manifest.caseResults.filter(
			(cr) => cr.evaluatedTier === tier && (cr.verdict === 'fail' || cr.verdict === 'error'),
		);

		if (failing.length === 0) {
			const result: PersistedWeaknessSummary = {
				status: 'no-failures',
				runId: manifest.runId,
				tier,
				modelId,
				generatedAt: new Date().toISOString(),
				hadFailures: false,
				summary: 'No failures recorded for this tier in this run.',
			};
			await atomicWriteJson(pathFor(manifest.runId, tier), result);
			return result;
		}

		const enriched = await loadFailingResults(failing, cacheDir, logger);
		if (enriched.length === 0) {
			// Cache files all missing or invalid — record an error state so the
			// GUI knows to render a "generate failed" cell.
			const result: PersistedWeaknessSummary = {
				status: 'error',
				runId: manifest.runId,
				tier,
				modelId,
				generatedAt: new Date().toISOString(),
				hadFailures: true,
				errorMessage:
					'no cache files could be read for failing cases (re-run with --no-cache to repopulate)',
			};
			await atomicWriteJson(pathFor(manifest.runId, tier), result);
			return result;
		}

		const prompt = buildPrompt(enriched.slice(0, maxFailing), tier, modelId);

		let raw = await llm.complete(prompt, {
			tier: 'standard',
			temperature: 0,
			maxTokens: 1500,
			responseFormat: 'json',
		});
		if (!raw || raw.trim() === '') {
			// One retry on empty output. The LLM call is idempotent (same prompt,
			// no state), so a single retry is sufficient.
			raw = await llm.complete(prompt, {
				tier: 'standard',
				temperature: 0,
				maxTokens: 1500,
				responseFormat: 'json',
			});
		}

		const parsed = tryParseSummaryJson(raw, failing.map((f) => f.caseId));
		const result: PersistedWeaknessSummary = parsed.ok
			? {
					status: 'ready',
					runId: manifest.runId,
					tier,
					modelId,
					generatedAt: new Date().toISOString(),
					hadFailures: true,
					failureCategories: parsed.value.failureCategories,
					summary: parsed.value.summary,
					llmRawOutput: raw,
				}
			: {
					status: 'error',
					runId: manifest.runId,
					tier,
					modelId,
					generatedAt: new Date().toISOString(),
					hadFailures: true,
					errorMessage: parsed.error,
					llmRawOutput: raw,
				};
		await atomicWriteJson(pathFor(manifest.runId, tier), result);
		return result;
	}

	return { summarize, pathFor, read };
}

function modelIdForTier(manifest: RunManifest, tier: SummaryTier): string {
	if (tier === 'fast') return manifest.modelIds.fast;
	if (tier === 'standard') return manifest.modelIds.standard;
	return manifest.modelIds.reasoning ?? '';
}

interface EnrichedFailure {
	caseId: string;
	bucket: string;
	verdict: 'fail' | 'error';
	inputs: unknown[];
	actuals: unknown[];
}

async function loadFailingResults(
	failing: readonly ManifestCaseResult[],
	cacheDir: string,
	logger: Logger,
): Promise<EnrichedFailure[]> {
	const loaded = await Promise.all(
		failing.map(async (cr): Promise<EnrichedFailure | null> => {
			const path = join(cacheDir, cr.caseId, `${cr.cacheKey}.json`);
			let buf: string;
			try {
				buf = await readFile(path, 'utf8');
			} catch (err) {
				logger.warn(
					{ caseId: cr.caseId, err: (err as Error).message },
					'weakness-summarizer: failing-case cache read failed — skipping',
				);
				return null;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(buf);
			} catch {
				return null;
			}
			if (!isPlainObject(parsed)) return null;
			const inner = (parsed as { result?: unknown }).result;
			if (!looksLikeRunResult(inner, cr.caseId, cr.cacheKey)) return null;
			const r = inner as RunResult;
			return {
				caseId: cr.caseId,
				bucket: cr.bucket,
				verdict: cr.verdict === 'fail' ? 'fail' : 'error',
				inputs: r.inputs.map((i) => i.payload),
				actuals: r.actuals,
			};
		}),
	);
	return loaded.filter((x): x is EnrichedFailure => x !== null);
}

/** Hard cap on each failing-case JSON payload to keep the LLM prompt bounded. */
const PER_FAILURE_MAX_CHARS = 4000;

function buildPrompt(
	failures: readonly EnrichedFailure[],
	tier: SummaryTier,
	modelId: string,
): string {
	// Each failing-case payload is sanitized via the canonical
	// `sanitizeContextContent` from the prompt-assembly stack: strips bidi /
	// zero-width controls, collapses ≥3-backtick fences, AND neutralizes
	// role-like XML tags (`<system>`, `<user>`, etc.) that could otherwise
	// inject hostile instructions into the LLM prompt from oracle output.
	const lines: string[] = [
		SYSTEM_PROMPT,
		'',
		`Tier evaluated: ${tier}`,
		`Model: ${modelId}`,
		`Total failing cases: ${failures.length}`,
		'',
		'Failures:',
		'```',
	];
	for (const f of failures) {
		const payload = JSON.stringify({
			caseId: f.caseId,
			bucket: f.bucket,
			verdict: f.verdict,
			inputs: f.inputs,
			actuals: f.actuals,
		});
		lines.push(sanitizeContextContent(payload, PER_FAILURE_MAX_CHARS, '… [truncated]'));
	}
	lines.push('```');
	return lines.join('\n');
}

interface ParsedSummary {
	summary: string;
	failureCategories: FailureCategory[];
}

function tryParseSummaryJson(
	raw: string,
	validCaseIds: readonly string[],
): { ok: true; value: ParsedSummary } | { ok: false; error: string } {
	const parsed = tryParseJsonStripFences(raw);
	if (parsed === UNPARSEABLE_JSON) {
		return { ok: false, error: 'LLM output is empty or not valid JSON (after retry)' };
	}
	if (!isPlainObject(parsed)) {
		return { ok: false, error: 'LLM output is not an object' };
	}
	if (typeof parsed.summary !== 'string' || parsed.summary.length === 0) {
		return { ok: false, error: 'LLM output missing string "summary"' };
	}
	if (!Array.isArray(parsed.failureCategories)) {
		return { ok: false, error: 'LLM output missing array "failureCategories"' };
	}
	const validSet = new Set(validCaseIds);
	const cats: FailureCategory[] = [];
	for (const c of parsed.failureCategories) {
		if (!isPlainObject(c)) continue;
		if (typeof c.label !== 'string' || !c.label.length) continue;
		if (typeof c.count !== 'number' || !Number.isFinite(c.count) || c.count < 0) continue;
		const ids = Array.isArray(c.exampleCaseIds)
			? c.exampleCaseIds.filter(
					(id): id is string => typeof id === 'string' && validSet.has(id),
				)
			: [];
		cats.push({ label: c.label, count: Math.floor(c.count), exampleCaseIds: ids });
	}
	if (cats.length === 0) {
		return { ok: false, error: 'no valid failureCategories in LLM output' };
	}
	return {
		ok: true,
		value: { summary: parsed.summary, failureCategories: cats },
	};
}

function isPersistedSummary(v: unknown): v is PersistedWeaknessSummary {
	if (!isPlainObject(v)) return false;
	if (typeof v.runId !== 'string') return false;
	if (typeof v.tier !== 'string') return false;
	if (typeof v.modelId !== 'string') return false;
	if (typeof v.generatedAt !== 'string') return false;
	if (typeof v.hadFailures !== 'boolean') return false;
	if (v.status !== 'ready' && v.status !== 'error' && v.status !== 'no-failures') return false;
	return true;
}
