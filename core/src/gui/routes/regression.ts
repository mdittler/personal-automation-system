import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ModelCatalog } from '../../services/llm/model-catalog.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import {
	normalizeOptionalModelSpec,
	parseJudgeModelValue,
	parseModelMatrixValue,
} from '../../services/regression/model-spec.js';
import {
	ROUTING_ACCURACY_GATE,
	type RunResult,
	SAFE_CASE_ID_RE,
	SAFE_RUN_ID_RE,
	VERDICT_VALUES,
	type Verdict,
	isValidBucket,
} from '../../types/regression.js';
import { requirePlatformAdmin } from '../guards/require-platform-admin.js';
import {
	type DisplayResult,
	readDisplayForCase,
	readHistoryForCase,
} from '../services/regression/cache-reader.js';
import type { CaseDiscoveryService, ListedCase } from '../services/regression/case-discovery.js';
import { renderLineChart, renderScatter } from '../services/regression/chart-svg.js';
import { type EstimatedCase, estimateRunCostUsd } from '../services/regression/estimator.js';
import {
	type LeaderboardTier,
	type PinOverrideKey,
	aggregateLeaderboard,
} from '../services/regression/leaderboard-aggregator.js';
import type { RunHistoryStore } from '../services/regression/run-history-store.js';
import {
	RegistrationConflictError,
	type RegressionEvent,
	type RunProgress,
	type RunRegistry,
	isTerminalEventType,
} from '../services/regression/run-registry.js';
import { openSseStream, writeSseEvent } from '../services/regression/sse-helper.js';
import { type SpawnFn, spawnRegression } from '../services/regression/subprocess.js';
import {
	buildCompleteBanner,
	buildGateFailedBanner,
} from '../services/regression/terminal-banner.js';
import { type TimeWindow, buildTrendData } from '../services/regression/trend-aggregator.js';
import type {
	SummaryTier,
	WeaknessSummarizer,
} from '../services/regression/weakness-summarizer.js';
import { sendErrorFragment } from '../utils/error-fragment.js';

export interface RegressionRoutesOptions {
	caseDiscovery: CaseDiscoveryService;
	runRegistry: RunRegistry;
	cacheDir: string;
	maxRunBudgetUsd: number;
	logger: Logger;
	/** Absolute path to `regression/src/runner/cli-main.ts`. Required for real spawns. */
	cliPath?: string;
	/** Working directory for spawned subprocess (repo root). */
	cwd?: string;
	/** Path to `regression/tsconfig.json`. Sets TSX_TSCONFIG_PATH so tsx finds aliases. */
	tsconfigPath?: string;
	/** Override the spawn factory (tests inject a fake). */
	spawnFn?: SpawnFn;
	/**
	 * Reads RunManifest files from `data/system/regression-runs/`. Required for
	 * the Overview/Trends tabs (REQ-REG-GUI-V2-004). Routes degrade to "no runs
	 * recorded yet" when this is unset or returns empty.
	 */
	runHistoryStore?: RunHistoryStore;
	/**
	 * Used by the Run tab to render `<select>` model dropdowns sourced from
	 * live provider listings (REQ-REG-GUI-V2-006/011). When omitted, the Run
	 * tab falls back to legacy text inputs.
	 */
	modelCatalog?: ModelCatalog;
	/**
	 * Reads current per-tier defaults to pre-select dropdown values and detect
	 * unavailable-current models (REQ-REG-GUI-V2-011).
	 */
	modelSelector?: ModelSelector;
	/**
	 * Generates the weakness summary persisted at the polled
	 * `/runs/:runId/summary` route (REQ-REG-GUI-V2-018/019). When omitted, the
	 * polled route returns 503 with a documented error.
	 */
	weaknessSummarizer?: WeaknessSummarizer;
}

const SAFE_RERUN_ID = /^[a-z][a-z0-9-]{0,127}$/;

interface DisplayedCase {
	caseId: string;
	bucket: string;
	routingTarget?: string;
	description: string;
	oracle: string;
	currentCacheKey: string;
	statusIcon: '✓' | '✗' | '⚠' | '●' | '⊘' | '◆';
	verdictLabel: string;
	modelFast: string;
	modelStandard: string;
	timestamp: string | null;
	costUsd: string;
	tokensInput: string;
	tokensOutput: string;
	hasResult: boolean;
}

/**
 * Verdict → status-icon map. Typed as `Record<Verdict, …>` so adding a
 * new variant to the `Verdict` union forces a compile error here — no
 * silent fallback to `◆` for an unhandled verdict.
 */
const VERDICT_ICON: Record<Verdict, DisplayedCase['statusIcon']> = {
	pass: '✓',
	fail: '✗',
	'budget-exceeded': '⊘',
	error: '◆',
};

/**
 * Normalize + validate an optional model-spec body field. Returns either the
 * trimmed string (or `undefined` for "no override") OR an error message ready
 * for a 400 response. Centralizes the two near-identical try/catch blocks the
 * POST handler would otherwise need for `modelMatrix` and `judgeModel`.
 */
function validateOptionalModelField(
	raw: unknown,
	fieldName: string,
	parser: (v: string) => unknown,
): { value: string | undefined; error: null } | { value: null; error: string } {
	try {
		const v = normalizeOptionalModelSpec(raw);
		if (v !== undefined) parser(v);
		return { value: v, error: null };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { value: null, error: `invalid ${fieldName}: ${msg}` };
	}
}

function buildDisplayedCase(listed: ListedCase, display: DisplayResult | null): DisplayedCase {
	if (!display) {
		return {
			caseId: listed.caseId,
			bucket: listed.bucket,
			...(listed.routingTarget ? { routingTarget: listed.routingTarget } : {}),
			description: listed.description,
			oracle: listed.oracle,
			currentCacheKey: listed.currentCacheKey,
			statusIcon: '●',
			verdictLabel: 'never run',
			modelFast: '—',
			modelStandard: '—',
			timestamp: null,
			costUsd: '—',
			tokensInput: '—',
			tokensOutput: '—',
			hasResult: false,
		};
	}
	const { result, coverageChanged } = display;
	const icon: DisplayedCase['statusIcon'] = coverageChanged
		? '⚠'
		: (VERDICT_ICON[result.verdict] ?? '◆');
	const label = coverageChanged ? 'coverage changed — needs re-run' : result.verdict;
	return {
		caseId: listed.caseId,
		bucket: listed.bucket,
		...(listed.routingTarget ? { routingTarget: listed.routingTarget } : {}),
		description: listed.description,
		oracle: listed.oracle,
		currentCacheKey: listed.currentCacheKey,
		statusIcon: icon,
		verdictLabel: label,
		modelFast: result.modelIds.fast,
		modelStandard: result.modelIds.standard,
		timestamp: result.timestamp,
		costUsd: result.costUsd.toFixed(4),
		tokensInput: String(result.tokenCounts.input),
		tokensOutput: String(result.tokenCounts.output),
		hasResult: true,
	};
}

export function registerRegressionRoutes(
	server: FastifyInstance,
	options: RegressionRoutesOptions,
): void {
	const { caseDiscovery, runRegistry, cacheDir, maxRunBudgetUsd, logger } = options;
	const { runHistoryStore, modelCatalog, modelSelector, weaknessSummarizer } = options;
	const platformAdminOnly = { preHandler: [requirePlatformAdmin] };

	// REQ-REG-GUI-V2-018: auto-generate weakness summaries on run completion.
	// The subprocess has written the RunManifest atomically before emitting
	// the terminal event; the manifest is on disk now and we can summarize.
	// Only `complete` and `gate-failed` carry meaningful failure data —
	// `failed` (subprocess crash) and `cancelled` (operator-initiated) have
	// no usable manifest to summarize against.
	if (weaknessSummarizer && runHistoryStore) {
		runRegistry.onTerminal((runId, status) => {
			if (status !== 'complete' && status !== 'gate-failed') return;
			scheduleAutoSummarize({
				runId,
				runHistoryStore,
				weaknessSummarizer,
				logger,
			}).catch((err) =>
				logger.warn(
					{ runId, err: (err as Error).message },
					'regression-gui: auto-summarize task threw',
				),
			);
		});
	}

	// ───────────────────────────────────────────────────── GET /gui/regression
	server.get('/regression', platformAdminOnly, async (request, reply) => {
		const q =
			(request.query as {
				view?: string;
				bucket?: string;
				pin?: string | string[];
				window?: string;
				tier?: string;
			}) ?? {};

		// REQ-REG-GUI-V2-005: legacy ?bucket=<x> with no ?view= → 302 to Compare.
		if (q.bucket && !q.view) {
			return reply.redirect(
				`/gui/regression?view=compare&bucket=${encodeURIComponent(q.bucket)}`,
				302,
			);
		}

		const view = parseView(q.view);
		const selectedBucket =
			q.bucket && isValidBucket(q.bucket) ? (q.bucket as DisplayedCase['bucket']) : null;
		const pinOverrides = parsePinOverrides(q.pin);

		if (view === 'overview') {
			return renderOverviewTab(reply, {
				runHistoryStore,
				weaknessSummarizer,
				pinOverrides,
				activeRunId: runRegistry.getActiveRunId(),
				logger,
			});
		}
		if (view === 'trends') {
			return renderTrendsTab(reply, {
				runHistoryStore,
				activeRunId: runRegistry.getActiveRunId(),
				selectedBucket,
				rawWindow: typeof q.window === 'string' ? q.window : undefined,
				rawTier: typeof q.tier === 'string' ? q.tier : undefined,
				logger,
			});
		}
		if (view === 'run') {
			return renderRunTab(reply, {
				modelCatalog,
				modelSelector,
				caseDiscovery,
				maxRunBudgetUsd,
				activeRunId: runRegistry.getActiveRunId(),
				selectedBucket,
				logger,
			});
		}
		// view === 'compare' (default fallback)
		const qAny = q as { model?: unknown; verdict?: unknown; caseId?: unknown };
		return renderCompareTab(reply, {
			caseDiscovery,
			cacheDir,
			maxRunBudgetUsd,
			activeRunId: runRegistry.getActiveRunId(),
			selectedBucket,
			compareFilters: parseCompareFilters(qAny),
			logger,
		});
	});

	// ─────────────────────── GET /gui/regression/runs/:runId/summary (REQ-REG-GUI-V2-018)
	// Polled by the client after SSE `complete`. Returns 200 with the rendered
	// summary cell when persisted, 202 if generation is in-progress, 503 when
	// the summarizer isn't wired (tests).
	server.get<{
		Params: { runId: string };
		Querystring: { tier?: string };
	}>('/regression/runs/:runId/summary', platformAdminOnly, async (request, reply) => {
		const { runId } = request.params;
		if (!isUuid(runId)) return reply.status(404).send('not found');
		const tierRaw = request.query.tier;
		if (!tierRaw || !isSummaryTier(tierRaw)) {
			return reply
				.status(400)
				.send({ error: 'tier query param required (fast|standard|reasoning)' });
		}
		if (!options.weaknessSummarizer) {
			return reply.status(503).send({ error: 'summarizer not configured' });
		}
		const existing = await options.weaknessSummarizer.read(runId, tierRaw);
		if (!existing) {
			return reply.status(202).send({ status: 'pending' });
		}
		return reply.viewAsync('partials/regression-weakness-summary', {
			summary: existing,
		});
	});

	// ─────────────────── POST /gui/regression/runs/:runId/summary (REQ-REG-GUI-V2-019)
	// Manual (re)generation. `?force=true` overwrites an existing file.
	server.post<{
		Params: { runId: string };
		Querystring: { force?: string };
	}>('/regression/runs/:runId/summary', platformAdminOnly, async (request, reply) => {
		const { runId } = request.params;
		if (!isUuid(runId)) return reply.status(404).send('not found');
		if (!options.weaknessSummarizer || !options.runHistoryStore) {
			return reply.status(503).send({ error: 'summarizer not configured' });
		}
		const manifest = await options.runHistoryStore.getById(runId);
		if (!manifest) return reply.status(404).send({ error: 'unknown runId' });
		const force = request.query.force === 'true';
		// Kick off summarization for every tier present in the manifest. Run
		// sequentially to avoid concurrent LLM bursts; the polled GET route
		// will pick up the persisted files as they land.
		const summarizer = options.weaknessSummarizer;
		(async () => {
			try {
				const tiers: SummaryTier[] = ['fast', 'standard', 'reasoning'];
				for (const tier of tiers) {
					const modelForTier =
						tier === 'fast'
							? manifest.modelIds.fast
							: tier === 'standard'
								? manifest.modelIds.standard
								: manifest.modelIds.reasoning;
					if (!modelForTier) continue;
					await summarizer.summarize({ manifest, tier, force });
				}
			} catch (err) {
				logger.warn(
					{ runId, err: (err as Error).message },
					'regression-gui: summarizer background task failed',
				);
			}
		})();
		return reply.status(202).send({ status: 'queued' });
	});

	// ──────────────────────── GET /gui/regression/cases/:caseId  (drilldown)
	server.get<{ Params: { caseId: string } }>(
		'/regression/cases/:caseId',
		platformAdminOnly,
		async (request, reply) => {
			const { caseId } = request.params;
			if (!SAFE_CASE_ID_RE.test(caseId)) {
				return sendErrorFragment(reply, 404, "That case couldn't be found.");
			}
			const discovery = await caseDiscovery.discover();
			const listed = discovery.cases.find((c) => c.caseId === caseId);
			if (!listed) {
				return sendErrorFragment(reply, 404, "That case couldn't be found.");
			}
			let display: DisplayResult | null = null;
			try {
				display = await readDisplayForCase(cacheDir, caseId, listed.currentCacheKey);
			} catch (err) {
				logger.warn({ caseId, err }, 'regression-gui: drilldown cache read failed');
			}
			return reply.viewAsync('partials/regression-drilldown', {
				listed,
				result: display?.result ?? null,
				coverageChanged: display?.coverageChanged ?? false,
			});
		},
	);

	// ─────────────────────────────── GET /gui/regression/cases/:caseId/row
	// Server-rendered single row, fetched by the SSE client after a
	// `case-completed` event. Keeps row HTML construction on the server so
	// no untrusted payload reaches client-side HTML builders.
	server.get<{ Params: { caseId: string }; Querystring: { runId?: string } }>(
		'/regression/cases/:caseId/row',
		platformAdminOnly,
		async (request, reply) => {
			const { caseId } = request.params;
			if (!SAFE_CASE_ID_RE.test(caseId)) return reply.status(404).send('not found');
			const discovery = await caseDiscovery.discover();
			const listed = discovery.cases.find((c) => c.caseId === caseId);
			if (!listed) return reply.status(404).send('not found');

			// Prefer the live run's result if a runId was provided AND the run
			// has already produced this case's result; otherwise fall back to
			// the cache display.
			let display: DisplayResult | null = null;
			const runId = request.query.runId;
			if (runId) {
				const state = runRegistry.get(runId);
				const liveResult = findLiveResult(state, caseId);
				if (liveResult) {
					display = { result: liveResult, coverageChanged: false };
				}
			}
			if (!display) {
				try {
					display = await readDisplayForCase(cacheDir, caseId, listed.currentCacheKey);
				} catch (err) {
					logger.warn({ caseId, err }, 'regression-gui: row cache read failed');
				}
			}
			const displayed = buildDisplayedCase(listed, display);
			return reply.viewAsync('partials/regression-case-row', { case: displayed });
		},
	);

	// ─────────────────────── GET /gui/regression/cases/:caseId/history
	server.get<{ Params: { caseId: string } }>(
		'/regression/cases/:caseId/history',
		platformAdminOnly,
		async (request, reply) => {
			const { caseId } = request.params;
			if (!SAFE_CASE_ID_RE.test(caseId)) {
				return sendErrorFragment(reply, 404, "That case couldn't be found.");
			}
			// Mirror the drilldown/row allowlist check so a regex-valid but
			// unknown caseId can't read a directory left behind by a removed
			// case definition.
			const discovery = await caseDiscovery.discover();
			const listed = discovery.cases.find((c) => c.caseId === caseId);
			if (!listed) {
				return sendErrorFragment(reply, 404, "That case couldn't be found.");
			}
			let entries: RunResult[];
			try {
				entries = await readHistoryForCase(cacheDir, caseId);
			} catch (err) {
				logger.warn({ caseId, err }, 'regression-gui: history read failed');
				entries = [];
			}
			return reply.viewAsync('partials/regression-history', {
				caseId,
				entries: entries.map((e) => ({
					timestamp: e.timestamp,
					verdict: e.verdict,
					costUsd: e.costUsd.toFixed(4),
					modelFast: e.modelIds.fast,
					modelStandard: e.modelIds.standard,
					cacheKey: e.cacheKey,
				})),
			});
		},
	);

	// ───────────────────────────────────── GET /gui/regression/estimate
	server.get(
		'/regression/estimate',
		platformAdminOnly,
		async (request: FastifyRequest, reply: FastifyReply) => {
			const q = request.query as { bucket?: string; rerun?: string | string[] } | undefined;
			const discovery = await caseDiscovery.discover();
			let filtered = discovery.cases;
			if (q?.bucket && isValidBucket(q.bucket)) {
				filtered = filtered.filter((c) => c.bucket === q.bucket);
			}
			const rerunIds = new Set(Array.isArray(q?.rerun) ? q.rerun : q?.rerun ? [q.rerun] : []);
			if (rerunIds.size > 0) filtered = filtered.filter((c) => rerunIds.has(c.caseId));
			const out = estimateRunCostUsd(
				filtered.map((c) => ({ caseId: c.caseId, bucket: c.bucket as EstimatedCase['bucket'] })),
				{ ceilingUsd: maxRunBudgetUsd },
			);
			const totalInputs = filtered.reduce((acc, c) => acc + c.inputCount, 0);
			return reply.send({
				totalUsd: out.estimateUsd,
				ceilingUsd: out.ceilingUsd,
				perBucketUsd: out.perBucketUsd,
				totalCases: filtered.length,
				totalInputs,
			});
		},
	);

	// ─────────────────────────────────── POST /gui/regression/runs
	server.post(
		'/regression/runs',
		platformAdminOnly,
		async (request: FastifyRequest, reply: FastifyReply) => {
			const body = (request.body ?? {}) as {
				bucket?: string;
				rerun?: string | string[];
				forceFresh?: string | boolean;
				modelMatrix?: unknown;
				judgeModel?: unknown;
				tier_fast?: unknown;
				tier_standard?: unknown;
				tier_reasoning?: unknown;
				judge?: unknown;
			};
			if (body.bucket && !isValidBucket(body.bucket)) {
				return reply.status(400).send({ error: `unknown bucket: ${body.bucket}` });
			}
			const rerunRaw = Array.isArray(body.rerun) ? body.rerun : body.rerun ? [body.rerun] : [];
			for (const id of rerunRaw) {
				if (typeof id !== 'string' || !SAFE_RERUN_ID.test(id)) {
					return reply.status(400).send({ error: 'invalid rerun id' });
				}
			}

			// REQ-REG-GUI-V2-012: server-side tier composition.
			// `tier_*` fields (from dropdowns) take precedence over the legacy
			// `modelMatrix` text input. `judge` field takes precedence over
			// legacy `judgeModel`. Live-catalog re-validation (REQ-REG-GUI-V2-011)
			// runs at submit time so an unavailable model can't slip through.
			let modelMatrixRaw: string | undefined;
			let judgeModelRaw: string | undefined;
			const tierFromDropdowns = composeTierMatrixFromBody(body);
			if (tierFromDropdowns) {
				modelMatrixRaw = tierFromDropdowns;
			} else {
				const mm = validateOptionalModelField(
					body.modelMatrix,
					'modelMatrix',
					parseModelMatrixValue,
				);
				if (mm.error !== null) return reply.status(400).send({ error: mm.error });
				modelMatrixRaw = mm.value ?? undefined;
			}
			const judgeFromDropdown = normalizeSelectValue(body.judge);
			if (judgeFromDropdown !== undefined) {
				judgeModelRaw = judgeFromDropdown;
			} else {
				const jm = validateOptionalModelField(body.judgeModel, 'judgeModel', parseJudgeModelValue);
				if (jm.error !== null) return reply.status(400).send({ error: jm.error });
				judgeModelRaw = jm.value ?? undefined;
			}

			// REQ-REG-GUI-V2-011: re-validate every submitted model against the
			// live catalog at submit time. Defense in depth — the dropdowns hide
			// unavailable currents, but a hand-crafted POST could still try one.
			if (modelCatalog) {
				const validationError = await validateModelsAgainstLiveCatalog(
					{ modelMatrixRaw, judgeModelRaw },
					modelCatalog,
					logger,
				);
				if (validationError) {
					return reply.status(400).send({ error: validationError });
				}
			}

			// Final shape validation for the composed strings (catches accidentally
			// malformed dropdown values too).
			if (modelMatrixRaw !== undefined) {
				try {
					parseModelMatrixValue(modelMatrixRaw);
				} catch (err) {
					return reply
						.status(400)
						.send({ error: `invalid modelMatrix: ${(err as Error).message}` });
				}
			}
			if (judgeModelRaw !== undefined) {
				try {
					parseJudgeModelValue(judgeModelRaw);
				} catch (err) {
					return reply.status(400).send({ error: `invalid judgeModel: ${(err as Error).message}` });
				}
			}

			const discovery = await caseDiscovery.discover();
			if (discovery.error) {
				return reply.status(400).send({ error: `case discovery failed: ${discovery.error}` });
			}
			const known = new Set(discovery.cases.map((c) => c.caseId));
			for (const id of rerunRaw) {
				if (!known.has(id)) {
					return reply.status(400).send({ error: `unknown case id: ${id}` });
				}
			}

			// The bucket filter is the ONLY thing that narrows the case set the
			// runner reports on, so it is computed unconditionally — both as
			// the progress denominator and as the forceFresh expansion source.
			const bucketFiltered = body.bucket
				? discovery.cases.filter((c) => c.bucket === body.bucket)
				: discovery.cases;
			// `--rerun` is deliberately excluded from the denominator: in
			// `regression/src/runner/index.ts:170` rerunIds only force a cache
			// MISS — every bucket-filtered case still reaches `onResult`,
			// cached or dispatched. Narrowing by rerun would under-count.
			const totalCases = bucketFiltered.length;

			// forceFresh expands the current filter into explicit rerun ids so
			// cached cases get re-dispatched. Reuses the existing --rerun
			// mechanism rather than introducing a new CLI flag.
			const rerunSet = new Set<string>(rerunRaw);
			const forceFresh = body.forceFresh === true || body.forceFresh === 'true';
			if (forceFresh) {
				for (const c of bucketFiltered) rerunSet.add(c.caseId);
			}

			const args: string[] = ['--json'];
			if (body.bucket) args.push(`--bucket=${body.bucket}`);
			for (const id of rerunSet) args.push(`--rerun=${id}`);
			if (modelMatrixRaw !== undefined) args.push(`--model-matrix=${modelMatrixRaw}`);
			if (judgeModelRaw !== undefined) args.push(`--judge-model=${judgeModelRaw}`);

			try {
				const { runId } = await runRegistry.createRun({
					args,
					totalCases,
					runFactory: async (onEvent, signal, registryRunId) => {
						// REQ-REG-GUI-V2-003: receive the canonical runId from the
						// registry as a factory argument (avoids a TDZ capture of the
						// outer `runId` since the factory is invoked during createRun).
						const subprocessArgs = [...args, `--run-id=${registryRunId}`];
						const handle = await spawnRegression(subprocessArgs, {
							spawnFn: options.spawnFn,
							cliPath: options.cliPath,
							cwd: options.cwd,
							tsconfigPath: options.tsconfigPath,
							onEvent,
							signal,
						});
						return { whenComplete: handle.whenComplete };
					},
				});
				return reply
					.status(202)
					.send({ runId, totalCases, eventsUrl: `/gui/regression/runs/${runId}/events` });
			} catch (err) {
				if (err instanceof RegistrationConflictError) {
					return reply.status(409).send({ activeRunId: err.activeRunId });
				}
				logger.error({ err }, 'regression-gui: spawnRegression failed');
				return reply.status(500).send({ error: 'failed to spawn run' });
			}
		},
	);

	// ──────────────── GET /gui/regression/runs/:runId/events  (SSE)
	// On reconnect the browser sends `Last-Event-ID`; we replay events
	// strictly newer than it then attach for live updates. If the next
	// expected id has been evicted, emit `event: gap` so the client reloads.
	server.get<{ Params: { runId: string } }>(
		'/regression/runs/:runId/events',
		platformAdminOnly,
		async (request, reply) => {
			const { runId } = request.params;
			if (!SAFE_RUN_ID_RE.test(runId)) return reply.status(404).send('not found');
			const state = runRegistry.get(runId);
			if (!state) return reply.status(404).send('not found');

			// Header is the only reconnect path: native `EventSource` cannot
			// mutate URL query on auto-retry, so a `?lastEventId=` fallback
			// would be dead weight.
			const lastEventIdHeader = request.headers['last-event-id'];
			let lastEventId: number | null = null;
			if (typeof lastEventIdHeader === 'string' && /^\d+$/.test(lastEventIdHeader)) {
				lastEventId = Number.parseInt(lastEventIdHeader, 10);
			}

			// Ensure the registry listener is detached when the client
			// disconnects, the SSE write fails, OR a terminal event triggers
			// `channel.close()`. Otherwise closed clients leave listeners
			// behind until the run is GC'd.
			let detach: (() => void) | null = null;
			const channel = openSseStream(request, reply, {
				onClose: () => detach?.(),
			});

			// Replay phase. The replay result is either a list of `{id, event}`
			// pairs strictly newer than `lastEventId`, or `{gap: true}` when the
			// ring buffer cannot satisfy the request.
			const replay = runRegistry.getEventsAfter(runId, lastEventId);
			if (Array.isArray(replay)) {
				let replayedTerminal = false;
				for (const { id, event, progress } of replay) {
					const sseEvent = toSseEvent(event, runId, progress);
					if (sseEvent) writeSseEvent(channel, { ...sseEvent, id });
					if (isTerminalEventType(event.type)) {
						replayedTerminal = true;
					}
				}
				// Close immediately when the run has already reached terminal:
				// either we just replayed the terminal event, OR the client's
				// lastEventId was newer than all retained events and no new ones
				// will arrive. Without this, attachLive would register a listener
				// that never receives anything.
				if (replayedTerminal || (replay.length === 0 && runRegistry.isTerminal(runId))) {
					channel.close();
					return;
				}
			} else {
				writeSseEvent(channel, { type: 'gap', data: {} });
				channel.close();
				return;
			}

			const dispatch = (event: RegressionEvent, id: number, progress: RunProgress): void => {
				const sseEvent = toSseEvent(event, runId, progress);
				if (sseEvent) writeSseEvent(channel, { ...sseEvent, id });
				if (isTerminalEventType(event.type)) {
					channel.close();
				}
			};
			detach = runRegistry.attachLive(runId, dispatch);
		},
	);

	// ────────────────────── POST /gui/regression/runs/:runId/cancel (REQ-REG-016)
	server.post<{ Params: { runId: string } }>(
		'/regression/runs/:runId/cancel',
		platformAdminOnly,
		async (request, reply) => {
			const { runId } = request.params;
			if (!SAFE_RUN_ID_RE.test(runId)) return reply.status(200).send({ ok: true });
			await runRegistry.cancel(runId);
			return reply.status(200).send({ ok: true });
		},
	);
}

// SSE case-completed events carry ONLY {caseId, runId} — never the full
// result payload. Clients fetch the row partial via htmx to get
// server-rendered, escaped HTML. Other event types pass through their
// (already trusted, number/enum-only) payloads.
function toSseEvent(
	event: RegressionEvent,
	runId: string,
	progress: RunProgress,
): { type: string; data: unknown } | null {
	switch (event.type) {
		case 'case-result': {
			const r = event.result as RunResult | undefined;
			if (!r) return null;
			// `completed`/`total` are server-computed numbers — no new XSS
			// surface, consistent with the {caseId, runId}-only rule above.
			return {
				type: 'case-completed',
				data: { caseId: r.caseId, runId, completed: progress.completed, total: progress.total },
			};
		}
		case 'summary':
			return { type: 'summary', data: event.summary };
		case 'complete':
			// The banner is formatted server-side (terminal-banner.ts) so the
			// client only assembles DOM text nodes. The raw `summary` and
			// `modelIds` ride alongside it so downstream consumers that read
			// the summary directly (or future ones) keep working — `banner`
			// is additive, not a replacement.
			return {
				type: 'complete',
				data: {
					banner: buildCompleteBanner(event.summary),
					summary: event.summary,
					modelIds: event.modelIds,
					runId,
				},
			};
		case 'gate-failed':
			return {
				type: 'gate-failed',
				data: {
					banner: buildGateFailedBanner(event.summary, event.modelIds),
					summary: event.summary,
					modelIds: event.modelIds,
					exitCode: event.exitCode,
					runId,
				},
			};
		case 'failed':
			return {
				type: 'failed',
				data: { exitCode: event.exitCode, stderrTail: event.stderrTail, runId },
			};
		case 'cancelled':
			return { type: 'cancelled', data: { runId } };
		default:
			return null;
	}
}

function findLiveResult(
	state: ReturnType<RunRegistry['get']> | undefined,
	caseId: string,
): RunResult | null {
	if (!state) return null;
	for (const entry of state.eventLog) {
		if (entry.event.type !== 'case-result') continue;
		const r = entry.event.result as RunResult | undefined;
		if (r && r.caseId === caseId) return r;
	}
	return null;
}

type ActiveView = 'overview' | 'trends' | 'compare' | 'run';
const VALID_VIEWS = new Set<ActiveView>(['overview', 'trends', 'compare', 'run']);

function parseView(raw: unknown): ActiveView {
	if (typeof raw === 'string' && VALID_VIEWS.has(raw as ActiveView)) return raw as ActiveView;
	return 'overview';
}

/**
 * REQ-REG-GUI-V2-010: parse `?pin=<tier>:<modelId>:<runId>` (repeatable).
 * Silently drops malformed entries — they show up as "no pin honored" rather
 * than a 400; the operator's filter just falls back to latest.
 */
function parsePinOverrides(raw: unknown): PinOverrideKey[] {
	if (raw === undefined || raw === null || raw === '') return [];
	const values: string[] = Array.isArray(raw)
		? raw.filter((v): v is string => typeof v === 'string')
		: typeof raw === 'string'
			? [raw]
			: [];
	const out: PinOverrideKey[] = [];
	for (const v of values) {
		// Split on first ":" then last ":". Middle is the modelId (may contain
		// `/` and `:` itself, e.g. "ollama/gemma3:31b") — split from both ends.
		const firstColon = v.indexOf(':');
		const lastColon = v.lastIndexOf(':');
		if (firstColon < 0 || lastColon === firstColon) continue;
		const tier = v.slice(0, firstColon);
		const modelId = v.slice(firstColon + 1, lastColon);
		const runId = v.slice(lastColon + 1);
		if (tier !== 'fast' && tier !== 'standard' && tier !== 'reasoning') continue;
		if (!modelId || !SAFE_RUN_ID_RE.test(runId)) continue;
		out.push({ tier: tier as LeaderboardTier, modelId, runId });
	}
	return out;
}

const TIER_TABLE_LABELS: Record<LeaderboardTier, string> = {
	fast: 'Fast',
	standard: 'Standard',
	reasoning: 'Reasoning',
};

/**
 * Format an ISO timestamp into a short human-friendly run-date string.
 * Used by the leaderboard `Run date` column (REQ-REG-GUI-V2-009).
 */
function formatRunDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const date = d.toISOString().slice(0, 10);
	const time = d.toISOString().slice(11, 16);
	return `${date} ${time}Z`;
}

/**
 * Routing gate status, computed from the *per-input* routing accuracy — the
 * same metric the runner gates on (REQ-REG-011). Per-case counts gate nothing,
 * so the badge must derive from `routingAccuracy`, not bucket pass/total.
 * `null` accuracy (non-fast row, or below the food-shadow input floor) → "—".
 */
function computeRoutingGate(routingAccuracy: number | null): 'pass' | 'fail' | null {
	if (routingAccuracy === null) return null;
	return routingAccuracy >= ROUTING_ACCURACY_GATE ? 'pass' : 'fail';
}

async function renderOverviewTab(
	reply: FastifyReply,
	deps: {
		runHistoryStore?: RunHistoryStore;
		weaknessSummarizer?: WeaknessSummarizer;
		pinOverrides: PinOverrideKey[];
		activeRunId: string | null;
		logger: Logger;
	},
): Promise<unknown> {
	let manifests: Awaited<ReturnType<RunHistoryStore['list']>> = [];
	if (deps.runHistoryStore) {
		try {
			manifests = await deps.runHistoryStore.list();
		} catch (err) {
			deps.logger.warn({ err }, 'regression-gui: run-history-store.list failed');
		}
	}
	const tiers: LeaderboardTier[] = ['fast', 'standard', 'reasoning'];
	const aggregated = tiers.map((tier) => ({
		tier,
		label: TIER_TABLE_LABELS[tier],
		rows: aggregateLeaderboard({ manifests, tier, pinOverrides: deps.pinOverrides }),
	}));

	// Pre-fetch persisted weakness summaries so a returning operator sees the
	// real summary on first paint instead of an empty placeholder. The polling
	// loop in regression-live.eta only runs after an SSE `complete` event, so
	// without this prefetch a refreshed page would show "generating…" forever.
	const summaryFetches: Array<
		Promise<{
			runId: string;
			tier: SummaryTier;
			summary: Awaited<ReturnType<WeaknessSummarizer['read']>>;
		}>
	> = [];
	if (deps.weaknessSummarizer) {
		const summarizer = deps.weaknessSummarizer;
		for (const table of aggregated) {
			for (const r of table.rows) {
				summaryFetches.push(
					summarizer.read(r.runId, r.tier).then((summary) => ({
						runId: r.runId,
						tier: r.tier,
						summary,
					})),
				);
			}
		}
	}
	const summaryByKey = new Map<string, Awaited<ReturnType<WeaknessSummarizer['read']>>>();
	for (const { runId, tier, summary } of await Promise.all(summaryFetches)) {
		summaryByKey.set(`${runId}:${tier}`, summary);
	}

	const tierTables = aggregated.map(({ tier, label, rows }) => ({
		tier,
		label,
		rows: rows.map((r) => ({
			...r,
			completedAtFormatted: formatRunDate(r.completedAt),
			passRateFormatted: `${(r.passRate * 100).toFixed(1)}%`,
			totalCostFormatted: `$${r.totalCostUsd.toFixed(4)}`,
			// Gate badge derives from the per-input routing accuracy — the metric
			// REQ-REG-011 actually gates on — so it can never disagree with the
			// runner. Rows without routing cases (routingAccuracy null) show "—".
			gateStatus: computeRoutingGate(r.routingAccuracy),
			routingAccuracyFormatted:
				r.routingAccuracy === null ? null : `${(r.routingAccuracy * 100).toFixed(1)}%`,
			persistedSummary: summaryByKey.get(`${r.runId}:${r.tier}`) ?? null,
		})),
	}));
	return reply.viewAsync('regression', {
		title: 'Regression — Overview — PAS',
		activePage: 'regression',
		activeView: 'overview',
		tierTables,
		activeRunId: deps.activeRunId,
	});
}

async function renderRunTab(
	reply: FastifyReply,
	deps: {
		modelCatalog?: ModelCatalog;
		modelSelector?: ModelSelector;
		caseDiscovery: CaseDiscoveryService;
		maxRunBudgetUsd: number;
		activeRunId: string | null;
		selectedBucket: DisplayedCase['bucket'] | null;
		logger: Logger;
	},
): Promise<unknown> {
	let modelGroups: Array<{ provider: string; models: Array<{ refId: string; label: string }> }> =
		[];
	let catalogError: string | null = null;
	const availableRefIds = new Set<string>();
	if (deps.modelCatalog) {
		try {
			const catalog = await deps.modelCatalog.getModels();
			const byProvider = new Map<string, Array<{ refId: string; label: string }>>();
			for (const m of catalog) {
				const provider = m.provider ?? m.providerType ?? 'unknown';
				const refId = `${provider}/${m.id}`;
				availableRefIds.add(refId);
				const list = byProvider.get(provider) ?? [];
				list.push({ refId, label: m.displayName || m.id });
				byProvider.set(provider, list);
			}
			modelGroups = Array.from(byProvider.entries())
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([provider, models]) => ({
					provider,
					models: models.sort((a, b) => a.label.localeCompare(b.label)),
				}));
		} catch (err) {
			catalogError = (err as Error).message;
			deps.logger.warn({ err }, 'regression-gui: model-catalog fetch failed');
		}
	}

	function tierConfigFor(ref: { provider: string; model: string } | null | undefined): {
		currentRef: { provider: string; model: string } | null;
		currentRefId: string | null;
		currentAvailable: boolean;
	} {
		if (!ref) return { currentRef: null, currentRefId: null, currentAvailable: true };
		const refId = `${ref.provider}/${ref.model}`;
		return {
			currentRef: { provider: ref.provider, model: ref.model },
			currentRefId: refId,
			currentAvailable: availableRefIds.has(refId),
		};
	}

	const fastRef = deps.modelSelector?.getFastRef() ?? null;
	const standardRef = deps.modelSelector?.getStandardRef() ?? null;
	const reasoningRef = deps.modelSelector?.getReasoningRef() ?? null;
	const tierConfigs = {
		fast: tierConfigFor(fastRef),
		standard: tierConfigFor(standardRef),
		reasoning: tierConfigFor(reasoningRef),
	};
	const judgeConfig = tierConfigFor(standardRef); // judge defaults to standard tier

	const discovery = await deps.caseDiscovery.discover();
	const filtered = deps.selectedBucket
		? discovery.cases.filter((c) => c.bucket === deps.selectedBucket)
		: discovery.cases;
	const estimate = estimateRunCostUsd(
		filtered.map((c) => ({ caseId: c.caseId, bucket: c.bucket as EstimatedCase['bucket'] })),
		{ ceilingUsd: deps.maxRunBudgetUsd },
	);
	const totalCases = filtered.length;
	const totalInputs = filtered.reduce((acc, c) => acc + c.inputCount, 0);

	return reply.viewAsync('regression', {
		title: 'Regression — Run — PAS',
		activePage: 'regression',
		activeView: 'run',
		activeRunId: deps.activeRunId,
		selectedBucket: deps.selectedBucket,
		modelGroups,
		tierConfigs,
		judgeConfig,
		catalogError,
		estimate: {
			totalUsd: estimate.estimateUsd.toFixed(2),
			ceilingUsd: estimate.ceilingUsd.toFixed(2),
			totalCases,
			totalInputs,
		},
	});
}

const VALID_WINDOWS = new Set<TimeWindow>(['7d', '30d', 'all']);
const VALID_TIERS_FOR_TRENDS = new Set<LeaderboardTier>(['fast', 'standard', 'reasoning']);

async function renderTrendsTab(
	reply: FastifyReply,
	deps: {
		runHistoryStore?: RunHistoryStore;
		activeRunId: string | null;
		selectedBucket: DisplayedCase['bucket'] | null;
		rawWindow?: string;
		rawTier?: string;
		logger: Logger;
	},
): Promise<unknown> {
	const window: TimeWindow =
		deps.rawWindow && VALID_WINDOWS.has(deps.rawWindow as TimeWindow)
			? (deps.rawWindow as TimeWindow)
			: '30d';
	const tier: LeaderboardTier =
		deps.rawTier && VALID_TIERS_FOR_TRENDS.has(deps.rawTier as LeaderboardTier)
			? (deps.rawTier as LeaderboardTier)
			: 'standard';
	let manifests: Awaited<ReturnType<RunHistoryStore['list']>> = [];
	if (deps.runHistoryStore) {
		try {
			manifests = await deps.runHistoryStore.list();
		} catch (err) {
			deps.logger.warn({ err }, 'regression-gui: trends list failed');
		}
	}
	const trend = buildTrendData({
		manifests,
		tier,
		bucket: deps.selectedBucket ?? undefined,
		window,
	});
	const showThreshold = (deps.selectedBucket ?? '') === 'routing';
	const lineSvg = renderLineChart({
		series: trend.lineSeries,
		width: 720,
		height: 280,
		yMin: 0,
		yMax: 1,
		thresholdY: showThreshold ? 0.95 : undefined,
		thresholdLabel: showThreshold ? 'REQ-REG-011 (0.95)' : undefined,
		yLabel: 'pass rate',
		xLabel: 'run date',
	});
	const scatterSvg = renderScatter({
		points: trend.scatterPoints,
		width: 720,
		height: 280,
		xLabel: 'total cost USD',
		yLabel: 'pass rate',
	});
	return reply.viewAsync('regression', {
		title: 'Regression — Trends — PAS',
		activePage: 'regression',
		activeView: 'trends',
		activeRunId: deps.activeRunId,
		selectedBucket: deps.selectedBucket,
		trendsWindow: window,
		trendsTier: tier,
		trendsLineSvg: lineSvg,
		trendsScatterSvg: scatterSvg,
		trendsTable: trend.tableRows,
		trendsHasData: trend.lineSeries.length > 0,
	});
}

/**
 * Compose `tier_fast` / `tier_standard` / `tier_reasoning` form fields into
 * a single `--model-matrix=...` CLI string. Returns `undefined` when no
 * dropdown was used (caller falls back to the legacy `modelMatrix` field).
 * Empty-string values mean "use pas.yaml default" — they're dropped.
 *
 * REQ-REG-GUI-V2-012.
 */
function composeTierMatrixFromBody(body: {
	tier_fast?: unknown;
	tier_standard?: unknown;
	tier_reasoning?: unknown;
}): string | undefined {
	const fast = normalizeSelectValue(body.tier_fast);
	const standard = normalizeSelectValue(body.tier_standard);
	const reasoning = normalizeSelectValue(body.tier_reasoning);
	const parts: string[] = [];
	if (fast !== undefined) parts.push(`fast=${fast}`);
	if (standard !== undefined) parts.push(`standard=${standard}`);
	if (reasoning !== undefined) parts.push(`reasoning=${reasoning}`);
	return parts.length > 0 ? parts.join(',') : undefined;
}

/**
 * Normalize a `<select>` form value. Returns `undefined` (meaning "no
 * dropdown selection") when the value is empty, whitespace, non-string,
 * an array (multi-select sent for a single-select), or an object.
 */
function normalizeSelectValue(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	return trimmed;
}

/**
 * Re-validate every submitted model ref against `ModelCatalog.getModels()`.
 * Returns an error string on rejection, or `null` on success.
 *
 * Defense in depth (REQ-REG-GUI-V2-011): the Run tab dropdowns hide
 * unavailable currents, but a hand-crafted POST could still try one.
 *
 * **Fail-closed semantics:** if no submitted refs need checking, skip the
 * catalog fetch and return null. Otherwise, a catalog fetch error blocks the
 * run — operators rerun once their providers are reachable. This trades a
 * usability regression for the user-requirement guarantee that submission of
 * an unavailable model is rejected.
 */
async function validateModelsAgainstLiveCatalog(
	composed: { modelMatrixRaw?: string; judgeModelRaw?: string },
	modelCatalog: ModelCatalog,
	logger: Logger,
): Promise<string | null> {
	const submitted = new Set<string>();
	if (composed.modelMatrixRaw) {
		try {
			const parsed = parseModelMatrixValue(composed.modelMatrixRaw);
			for (const tier of ['fast', 'standard', 'reasoning'] as const) {
				const ref = parsed[tier];
				if (ref) submitted.add(`${ref.provider}/${ref.model}`);
			}
		} catch {
			// Shape error — surface in the dedicated parseModelMatrixValue gate
			// caller, not here.
			return null;
		}
	}
	if (composed.judgeModelRaw) {
		try {
			const ref = parseJudgeModelValue(composed.judgeModelRaw);
			submitted.add(`${ref.provider}/${ref.model}`);
		} catch {
			return null;
		}
	}
	if (submitted.size === 0) return null;

	let catalog: Awaited<ReturnType<typeof modelCatalog.getModels>>;
	try {
		catalog = await modelCatalog.getModels();
	} catch (err) {
		// Fail closed: the user requirement is "currently available models
		// only"; a failed catalog fetch cannot prove availability so we
		// reject the run rather than waving it through.
		logger.warn(
			{ err: (err as Error).message },
			'regression-gui: model-catalog fetch failed during POST validation — rejecting (fail-closed)',
		);
		return 'live provider catalog unavailable — cannot verify model availability, please retry';
	}
	const available = new Set<string>();
	for (const m of catalog) {
		const provider = m.provider ?? m.providerType ?? 'unknown';
		available.add(`${provider}/${m.id}`);
	}
	for (const ref of submitted) {
		if (!available.has(ref)) {
			return `model not currently available from any registered provider: ${ref}`;
		}
	}
	return null;
}

/** REQ-REG-GUI-V2-017: Compare filter chips (model / verdict / bucket / caseId). */
export interface CompareFilters {
	model?: string;
	verdict?: Verdict;
	caseId?: string;
}

function parseCompareFilters(q: {
	model?: unknown;
	verdict?: unknown;
	caseId?: unknown;
}): CompareFilters {
	const out: CompareFilters = {};
	if (typeof q.model === 'string' && q.model.trim()) out.model = q.model.trim();
	if (typeof q.verdict === 'string' && (VERDICT_VALUES as readonly string[]).includes(q.verdict)) {
		out.verdict = q.verdict as Verdict;
	}
	if (typeof q.caseId === 'string' && SAFE_CASE_ID_RE.test(q.caseId)) out.caseId = q.caseId;
	return out;
}

async function renderCompareTab(
	reply: FastifyReply,
	deps: {
		caseDiscovery: CaseDiscoveryService;
		cacheDir: string;
		maxRunBudgetUsd: number;
		activeRunId: string | null;
		selectedBucket: DisplayedCase['bucket'] | null;
		compareFilters?: CompareFilters;
		logger: Logger;
	},
): Promise<unknown> {
	const filters = deps.compareFilters ?? {};
	const discovery = await deps.caseDiscovery.discover();

	// When ?caseId= is set, render ALL historical entries for that case
	// across every run/model, sorted desc by timestamp — makes the "see
	// across all runs" drilldown link match its label. Other filters
	// (model/verdict) apply to those rows after history expansion.
	if (filters.caseId) {
		const listed = discovery.cases.find((c) => c.caseId === filters.caseId);
		if (!listed) {
			return reply.viewAsync('regression', {
				title: 'Regression — Compare — PAS',
				activePage: 'regression',
				activeView: 'compare',
				cases: [],
				historicalRows: [],
				modelIds: discovery.modelIds ?? null,
				discoveryError: discovery.error ?? null,
				selectedBucket: deps.selectedBucket,
				compareFilters: filters,
				estimate: {
					totalUsd: '0.00',
					ceilingUsd: deps.maxRunBudgetUsd.toFixed(2),
					totalCases: 0,
					totalInputs: 0,
				},
				activeRunId: deps.activeRunId,
			});
		}
		let historicalRows: HistoricalRow[] = [];
		try {
			const entries = await readHistoryForCase(deps.cacheDir, filters.caseId);
			historicalRows = entries
				.map((e) => ({
					caseId: filters.caseId!,
					bucket: listed.bucket,
					timestamp: e.timestamp,
					verdict: e.verdict,
					costUsd: e.costUsd.toFixed(4),
					modelFast: e.modelIds.fast,
					modelStandard: e.modelIds.standard,
					modelReasoning: e.modelIds.reasoning ?? '—',
					cacheKey: e.cacheKey,
				}))
				.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		} catch (err) {
			deps.logger.warn(
				{ caseId: filters.caseId, err },
				'regression-gui: cross-run history read failed',
			);
		}
		// Apply post-history filters.
		if (filters.model) {
			historicalRows = historicalRows.filter(
				(r) =>
					r.modelFast === filters.model ||
					r.modelStandard === filters.model ||
					r.modelReasoning === filters.model,
			);
		}
		if (filters.verdict) {
			historicalRows = historicalRows.filter((r) => r.verdict === filters.verdict);
		}
		return reply.viewAsync('regression', {
			title: 'Regression — Compare — PAS',
			activePage: 'regression',
			activeView: 'compare',
			cases: [],
			historicalRows,
			historicalCaseId: filters.caseId,
			modelIds: discovery.modelIds ?? null,
			discoveryError: discovery.error ?? null,
			selectedBucket: deps.selectedBucket,
			compareFilters: filters,
			estimate: {
				totalUsd: '0.00',
				ceilingUsd: deps.maxRunBudgetUsd.toFixed(2),
				totalCases: 0,
				totalInputs: 0,
			},
			activeRunId: deps.activeRunId,
		});
	}

	const filtered = deps.selectedBucket
		? discovery.cases.filter((c) => c.bucket === deps.selectedBucket)
		: discovery.cases;
	const displays = await Promise.all(
		filtered.map((c) =>
			readDisplayForCase(deps.cacheDir, c.caseId, c.currentCacheKey).catch((err) => {
				deps.logger.warn(
					{ caseId: c.caseId, err },
					'regression-gui: cache-reader failed for case (treating as never-run)',
				);
				return null;
			}),
		),
	);
	let cases: DisplayedCase[] = filtered.map((c, i) => buildDisplayedCase(c, displays[i] ?? null));
	// Apply post-display filters (model + verdict). These need the resolved
	// row data so they can't happen earlier.
	if (filters.model) {
		cases = cases.filter((c) => c.modelFast === filters.model || c.modelStandard === filters.model);
	}
	if (filters.verdict) {
		cases = cases.filter((c) => c.verdictLabel === filters.verdict);
	}

	const estimate = estimateRunCostUsd(
		filtered.map((c) => ({ caseId: c.caseId, bucket: c.bucket as EstimatedCase['bucket'] })),
		{ ceilingUsd: deps.maxRunBudgetUsd },
	);
	const totalInputs = filtered.reduce((acc, c) => acc + c.inputCount, 0);
	return reply.viewAsync('regression', {
		title: 'Regression — Compare — PAS',
		activePage: 'regression',
		activeView: 'compare',
		cases,
		historicalRows: null,
		modelIds: discovery.modelIds ?? null,
		discoveryError: discovery.error ?? null,
		selectedBucket: deps.selectedBucket,
		compareFilters: filters,
		estimate: {
			totalUsd: estimate.estimateUsd.toFixed(2),
			ceilingUsd: estimate.ceilingUsd.toFixed(2),
			totalCases: filtered.length,
			totalInputs,
		},
		activeRunId: deps.activeRunId,
	});
}

interface HistoricalRow {
	caseId: string;
	bucket: string;
	timestamp: string;
	verdict: string;
	costUsd: string;
	modelFast: string;
	modelStandard: string;
	modelReasoning: string;
	cacheKey: string;
}

function isUuid(v: string): boolean {
	return SAFE_RUN_ID_RE.test(v);
}

function isSummaryTier(v: string): v is SummaryTier {
	return v === 'fast' || v === 'standard' || v === 'reasoning';
}

/**
 * REQ-REG-GUI-V2-018: auto-summarize every tier represented in a completed
 * run's manifest. Idempotent by virtue of `WeaknessSummarizer.summarize`
 * skipping when the persisted file exists. The hook is fire-and-forget;
 * the polled `/runs/:runId/summary?tier=...` endpoint reads the persisted
 * file as it lands.
 */
async function scheduleAutoSummarize(opts: {
	runId: string;
	runHistoryStore: RunHistoryStore;
	weaknessSummarizer: WeaknessSummarizer;
	logger: Logger;
}): Promise<void> {
	const manifest = await opts.runHistoryStore.getById(opts.runId);
	if (!manifest) {
		opts.logger.warn(
			{ runId: opts.runId },
			'regression-gui: auto-summarize skipped — manifest not found (subprocess may have crashed before write)',
		);
		return;
	}
	const evaluatedTiers = new Set<SummaryTier>();
	for (const cr of manifest.caseResults) {
		if (
			cr.evaluatedTier === 'fast' ||
			cr.evaluatedTier === 'standard' ||
			cr.evaluatedTier === 'reasoning'
		) {
			evaluatedTiers.add(cr.evaluatedTier);
		}
	}
	for (const tier of evaluatedTiers) {
		try {
			await opts.weaknessSummarizer.summarize({ manifest, tier });
		} catch (err) {
			opts.logger.warn(
				{ runId: opts.runId, tier, err: (err as Error).message },
				'regression-gui: auto-summarize tier failed',
			);
		}
	}
}
