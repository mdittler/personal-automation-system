/**
 * /gui/regression — Persona Regression Suite admin page.
 *
 * REQ-REG-007: admin-only via `requirePlatformAdmin` on every route.
 * REQ-REG-013: per-case model IDs, token counts, cost, timestamp.
 *
 * This file registers the **read-only** routes for Batch 3 of B.2:
 *   GET  /gui/regression                       — main page
 *   GET  /gui/regression/cases/:caseId         — drilldown partial
 *   GET  /gui/regression/cases/:caseId/row     — single case row (Codex I7;
 *                                                 fetched by SSE client)
 *   GET  /gui/regression/cases/:caseId/history — history tab partial
 *   GET  /gui/regression/estimate              — JSON estimate for confirm dialog
 *
 * The **write** routes (POST /runs, GET /runs/:runId/events, POST cancel)
 * are added in Batch 4. They share the same `RegressionRoutesOptions`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { RunResult } from '../../types/regression.js';
import { requirePlatformAdmin } from '../guards/require-platform-admin.js';
import {
	type DisplayResult,
	readDisplayForCase,
	readHistoryForCase,
} from '../services/regression/cache-reader.js';
import type { CaseDiscoveryService, ListedCase } from '../services/regression/case-discovery.js';
import { type EstimatedCase, estimateRunCostUsd } from '../services/regression/estimator.js';
import type { RunRegistry } from '../services/regression/run-registry.js';

const SAFE_CASE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const VALID_BUCKETS = new Set(['routing', 'receipt', 'chatbot', 'recall']);

export interface RegressionRoutesOptions {
	caseDiscovery: CaseDiscoveryService;
	runRegistry: RunRegistry;
	cacheDir: string;
	maxRunBudgetUsd: number;
	logger: Logger;
}

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
	hasResult: boolean;
}

const VERDICT_ICON: Record<string, DisplayedCase['statusIcon']> = {
	pass: '✓',
	fail: '✗',
	'budget-exceeded': '⊘',
	error: '◆',
};

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
		hasResult: true,
	};
}

export function registerRegressionRoutes(
	server: FastifyInstance,
	options: RegressionRoutesOptions,
): void {
	const { caseDiscovery, runRegistry, cacheDir, maxRunBudgetUsd, logger } = options;
	const platformAdminOnly = { preHandler: [requirePlatformAdmin] };

	// ───────────────────────────────────────────────────── GET /gui/regression
	server.get('/regression', platformAdminOnly, async (request, reply) => {
		const bucketParam = (request.query as { bucket?: string } | undefined)?.bucket;
		const discovery = await caseDiscovery.discover();
		const filtered =
			bucketParam && VALID_BUCKETS.has(bucketParam)
				? discovery.cases.filter((c) => c.bucket === bucketParam)
				: discovery.cases;
		const displays = await Promise.all(
			filtered.map((c) =>
				readDisplayForCase(cacheDir, c.caseId, c.currentCacheKey).catch((err) => {
					logger.warn(
						{ caseId: c.caseId, err },
						'regression-gui: cache-reader failed for case (treating as never-run)',
					);
					return null;
				}),
			),
		);
		const cases: DisplayedCase[] = filtered.map((c, i) =>
			buildDisplayedCase(c, displays[i] ?? null),
		);
		const estimate = estimateRunCostUsd(
			filtered.map((c) => ({ caseId: c.caseId, bucket: c.bucket as EstimatedCase['bucket'] })),
			{ ceilingUsd: maxRunBudgetUsd },
		);
		const activeRunId = findActiveRunId(runRegistry);
		return reply.viewAsync('regression', {
			title: 'Regression — PAS',
			activePage: 'regression',
			cases,
			modelIds: discovery.modelIds ?? null,
			discoveryError: discovery.error ?? null,
			selectedBucket: bucketParam && VALID_BUCKETS.has(bucketParam) ? bucketParam : null,
			estimate: {
				totalUsd: estimate.estimateUsd.toFixed(2),
				ceilingUsd: estimate.ceilingUsd.toFixed(2),
			},
			activeRunId,
		});
	});

	// ──────────────────────── GET /gui/regression/cases/:caseId  (drilldown)
	server.get<{ Params: { caseId: string } }>(
		'/regression/cases/:caseId',
		platformAdminOnly,
		async (request, reply) => {
			const { caseId } = request.params;
			if (!SAFE_CASE_ID.test(caseId)) return reply.status(404).send('not found');
			const discovery = await caseDiscovery.discover();
			const listed = discovery.cases.find((c) => c.caseId === caseId);
			if (!listed) return reply.status(404).send('not found');
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
	// Codex I7: server-rendered single row, fetched by the SSE client after
	// a `case-completed` event. Keeps row HTML construction on the server so
	// no untrusted payload reaches client-side HTML builders.
	server.get<{ Params: { caseId: string }; Querystring: { runId?: string } }>(
		'/regression/cases/:caseId/row',
		platformAdminOnly,
		async (request, reply) => {
			const { caseId } = request.params;
			if (!SAFE_CASE_ID.test(caseId)) return reply.status(404).send('not found');
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
			if (!SAFE_CASE_ID.test(caseId)) return reply.status(404).send('not found');
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
			if (q?.bucket && VALID_BUCKETS.has(q.bucket)) {
				filtered = filtered.filter((c) => c.bucket === q.bucket);
			}
			const rerunIds = new Set(Array.isArray(q?.rerun) ? q.rerun : q?.rerun ? [q.rerun] : []);
			if (rerunIds.size > 0) filtered = filtered.filter((c) => rerunIds.has(c.caseId));
			const out = estimateRunCostUsd(
				filtered.map((c) => ({ caseId: c.caseId, bucket: c.bucket as EstimatedCase['bucket'] })),
				{ ceilingUsd: maxRunBudgetUsd },
			);
			return reply.send({
				totalUsd: out.estimateUsd,
				ceilingUsd: out.ceilingUsd,
				perBucketUsd: out.perBucketUsd,
				totalCases: filtered.length,
			});
		},
	);
}

function findActiveRunId(registry: RunRegistry): string | null {
	// The registry doesn't expose iteration directly. Active runs are those
	// in starting/running/cancelling status. We probe by attempting a known
	// terminal lookup — but since we don't have direct iteration, we instead
	// trust the createRun-throws-on-conflict contract: the route catches that
	// in Batch 4. For now, the page renders without an activeRunId on first
	// load; the live progress block is hidden until a POST returns one.
	void registry;
	return null;
}

function findLiveResult(
	state: ReturnType<RunRegistry['get']> | undefined,
	caseId: string,
): RunResult | null {
	if (!state) return null;
	for (const event of state.events) {
		if (event.type !== 'case-result') continue;
		const r = event.result as RunResult | undefined;
		if (r && r.caseId === caseId) return r;
	}
	return null;
}
