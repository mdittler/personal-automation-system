/**
 * Permission-scoped JSON metrics endpoints for GUI charts (Batch 2 of the
 * GUI UX redesign).
 *
 * GET /gui/api/metrics/llm-daily      — per-day cost/token totals.
 * GET /gui/api/metrics/activity-daily — per-day message counts + alert firings.
 *
 * Both endpoints scope to the requesting member's own data unless the
 * requester is a platform admin, in which case all data is aggregated and a
 * per-user/per-app breakdown is also included. Scoping is always derived
 * from `request.user` — never from query params.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AlertService } from '../../services/alerts/index.js';
import type { ChatTranscriptIndex } from '../../services/chat-transcript-index/index.js';
import { countAlertFiringsByDay } from '../utils/alert-history-stats.js';
import { isGuiAdmin } from '../utils/gui-admin.js';
import { parseUsageMarkdown } from './llm-usage.js';

export interface MetricsRoutesOptions {
	dataDir: string;
	/** Optional — when absent, activity-daily's message counts are always 0. */
	chatTranscriptIndex?: Pick<ChatTranscriptIndex, 'countMessagesByDay'>;
	/**
	 * Optional — used to scope alert-firing counts to the requesting member's
	 * own alerts (those whose `delivery` includes their userId). Admins are
	 * unaffected. When absent, non-admins get 0 alert firings rather than the
	 * system-wide count.
	 */
	alertService?: Pick<AlertService, 'listAlerts'>;
	logger: Logger;
}

export interface LlmDailyDay {
	date: string;
	cost: number;
	inputTokens: number;
	outputTokens: number;
}

export interface LlmDailyResponse {
	days: LlmDailyDay[];
	perUser?: Array<{ user: string; cost: number }>;
	perApp: Array<{ app: string; cost: number }>;
}

export interface ActivityDailyDay {
	date: string;
	messages: number;
	alertFirings: number;
}

export interface ActivityDailyResponse {
	days: ActivityDailyDay[];
}

const DAYS_MIN = 1;
const DAYS_MAX = 90;
const DAYS_DEFAULT = 30;
const ACTIVITY_DAYS_MAX = 90;
const ACTIVITY_DAYS_DEFAULT = 30;

/**
 * Both endpoints return per-user-scoped data (own rows unless admin) — a
 * shared/proxy cache must never serve one user's response to another, so
 * `private` is mandatory. `max-age=30` keeps rapid chart-refresh polling
 * cheap without serving meaningfully stale data (final Codex review round,
 * Minor).
 */
const METRICS_CACHE_CONTROL = 'private, max-age=30';

function clampDays(raw: unknown, fallback: number, max: number): number {
	const n = Number.parseInt(String(raw ?? ''), 10);
	if (Number.isNaN(n)) return fallback;
	return Math.min(max, Math.max(DAYS_MIN, n));
}

function sinceIsoForDays(days: number): string {
	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	return cutoff.toISOString();
}

export function registerMetricsRoutes(
	server: FastifyInstance,
	options: MetricsRoutesOptions,
): void {
	const { dataDir, chatTranscriptIndex, alertService, logger } = options;

	server.get(
		'/api/metrics/llm-daily',
		async (
			request: FastifyRequest<{ Querystring: { days?: string } }>,
			reply: FastifyReply,
		): Promise<LlmDailyResponse> => {
			reply.header('Cache-Control', METRICS_CACHE_CONTROL);
			const actor = request.user;
			// Legacy shared-token mode (no per-user auth deps at all) leaves
			// request.user undefined for the whole request — isGuiAdmin treats
			// that as admin (the existing codebase convention; see its doc
			// comment), rather than Boolean(actor?.isPlatformAdmin) silently
			// scoping an unscoped-by-design legacy session down to empty/self-only data.
			const isAdmin = isGuiAdmin(request);
			const days = clampDays(request.query.days, DAYS_DEFAULT, DAYS_MAX);
			const sinceIso = sinceIsoForDays(days);
			const sinceDate = sinceIso.slice(0, 10);

			let content = '';
			try {
				content = await readFile(join(dataDir, 'system', 'llm-usage.md'), 'utf-8');
			} catch {
				// No usage log yet — empty series, not an error.
				return { days: [], perApp: [] };
			}

			if (!content.trim()) {
				return { days: [], perApp: [] };
			}

			const { rows } = parseUsageMarkdown(content);
			const scopedRows = isAdmin ? rows : rows.filter((r) => r.user === actor?.userId);

			const dayMap = new Map<string, LlmDailyDay>();
			const appMap = new Map<string, number>();
			const userMap = new Map<string, number>();

			for (const row of scopedRows) {
				const date = row.timestamp.slice(0, 10);
				if (date < sinceDate) continue;
				const cost = Number.parseFloat(row.cost) || 0;
				const inputTokens = Number.parseInt(row.inputTokens, 10) || 0;
				const outputTokens = Number.parseInt(row.outputTokens, 10) || 0;

				let day = dayMap.get(date);
				if (!day) {
					day = { date, cost: 0, inputTokens: 0, outputTokens: 0 };
					dayMap.set(date, day);
				}
				day.cost = Math.round((day.cost + cost) * 1e6) / 1e6;
				day.inputTokens += inputTokens;
				day.outputTokens += outputTokens;

				if (row.app) {
					appMap.set(row.app, Math.round(((appMap.get(row.app) ?? 0) + cost) * 1e6) / 1e6);
				}
				if (isAdmin && row.user && row.user !== '-') {
					userMap.set(row.user, Math.round(((userMap.get(row.user) ?? 0) + cost) * 1e6) / 1e6);
				}
			}

			const days_ = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
			const perApp = [...appMap.entries()]
				.map(([app, cost]) => ({ app, cost }))
				.sort((a, b) => b.cost - a.cost);

			const response: LlmDailyResponse = { days: days_, perApp };
			if (isAdmin) {
				response.perUser = [...userMap.entries()]
					.map(([user, cost]) => ({ user, cost }))
					.sort((a, b) => b.cost - a.cost);
			}
			return response;
		},
	);

	server.get(
		'/api/metrics/activity-daily',
		async (
			request: FastifyRequest<{ Querystring: { days?: string } }>,
			reply: FastifyReply,
		): Promise<ActivityDailyResponse> => {
			reply.header('Cache-Control', METRICS_CACHE_CONTROL);
			const actor = request.user;
			// Legacy shared-token mode (no per-user auth deps at all) leaves
			// request.user undefined for the whole request — isGuiAdmin treats
			// that as admin (the existing codebase convention; see its doc
			// comment), rather than Boolean(actor?.isPlatformAdmin) silently
			// scoping an unscoped-by-design legacy session down to empty/self-only data.
			const isAdmin = isGuiAdmin(request);
			const days = clampDays(request.query.days, ACTIVITY_DAYS_DEFAULT, ACTIVITY_DAYS_MAX);
			const sinceIso = sinceIsoForDays(days);

			let messageCounts: Array<{ date: string; count: number }> = [];
			if (chatTranscriptIndex) {
				try {
					messageCounts = await chatTranscriptIndex.countMessagesByDay({
						userId: isAdmin ? undefined : actor?.userId,
						sinceIso,
					});
				} catch (error) {
					logger.warn(
						{ error: error instanceof Error ? error.message : String(error) },
						'activity-daily: failed to load message counts',
					);
				}
			}

			let alertCounts: Array<{ date: string; count: number }> = [];
			try {
				let alertIds: string[] | undefined;
				if (!isAdmin) {
					// Members only see firings for alerts delivered to them — resolve
					// their alert ids first and restrict the history scan to those
					// alert-history directories. Missing alertService => no ids => 0.
					const alerts = alertService ? await alertService.listAlerts() : [];
					alertIds = alerts
						.filter((a) => a.delivery.includes(actor?.userId ?? ''))
						.map((a) => a.id);
				}
				alertCounts = await countAlertFiringsByDay(dataDir, { sinceIso, alertIds });
			} catch (error) {
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					'activity-daily: failed to load alert-firing counts',
				);
			}

			const dayMap = new Map<string, ActivityDailyDay>();
			for (const m of messageCounts) {
				dayMap.set(m.date, { date: m.date, messages: m.count, alertFirings: 0 });
			}
			for (const a of alertCounts) {
				const existing = dayMap.get(a.date);
				if (existing) {
					existing.alertFirings = a.count;
				} else {
					dayMap.set(a.date, { date: a.date, messages: 0, alertFirings: a.count });
				}
			}

			const days_ = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
			return { days: days_ };
		},
	);
}
