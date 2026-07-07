/**
 * Home route (Batch 2 of the GUI UX redesign — replaces the ops dashboard).
 *
 * GET /gui/ — three-zone layout: attention banners (admin-only system
 * health), glance metrics (scoped to the requesting member unless admin),
 * and a recent-activity snippet, plus registry-driven chart slots.
 *
 * Ops content that used to live here has been re-homed:
 *   - system config table  -> /gui/config
 *   - users table          -> /gui/users
 *   - uptime/cron detail   -> /gui/scheduler (small uptime line added there)
 *
 * Every attention-banner probe is independently try/caught — a failing
 * probe renders no banner, never a 500.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { chartsForPage } from '../../gui/charts/registry.js';
import type { AppRegistry } from '../../services/app-registry/index.js';
import { collectChanges } from '../../services/daily-diff/collector.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { SchedulerServiceImpl } from '../../services/scheduler/index.js';
import type { SystemConfig } from '../../types/config.js';
import { formatRelativeTime, getNextRun } from '../../utils/cron-describe.js';
import { parseUsageMarkdown } from './llm-usage.js';

export interface DashboardOptions {
	registry: AppRegistry;
	scheduler: SchedulerServiceImpl;
	config: SystemConfig;
	modelSelector: ModelSelector;
	dataDir: string;
	logger: Logger;
	/** Optional — used for the active-alerts glance card. */
	alertService?: {
		listAlerts(): Promise<
			Array<{ id: string; name: string; enabled: boolean; delivery: string[] }>
		>;
	};
	/** Optional — used for the next-scheduled-report glance card. */
	reportService?: {
		listReports(): Promise<
			Array<{ id: string; name: string; enabled: boolean; delivery: string[]; schedule: string }>
		>;
	};
}

interface AttentionBanner {
	kind: 'warning' | 'info';
	message: string;
	hint?: string;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function formatUptime(seconds: number): string {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (mins > 0) parts.push(`${mins}m`);
	parts.push(`${secs}s`);
	return parts.join(' ');
}

async function checkBackupBanner(
	config: SystemConfig,
	logger: Logger,
): Promise<AttentionBanner | null> {
	try {
		if (!config.backup?.enabled) {
			return {
				kind: 'warning',
				message: "Your data isn't being backed up.",
				hint: 'backup:\n  enabled: true\n  path: /path/to/backups\n\nAdd this to config/pas.yaml and restart to turn it on.',
			};
		}
		// Enabled — check freshness by stat'ing the newest archive directly
		// (no BackupService instance exists at GUI-registration time).
		let entries: string[];
		try {
			entries = await readdir(config.backup.path);
		} catch {
			return {
				kind: 'warning',
				message: 'Backups are turned on, but no backup has run yet.',
			};
		}
		const archives = entries.filter((f) => f.endsWith('.tar.gz'));
		if (archives.length === 0) {
			return { kind: 'warning', message: 'Backups are turned on, but no backup has run yet.' };
		}
		let newest = 0;
		for (const f of archives) {
			try {
				const s = await stat(join(config.backup.path, f));
				if (s.mtimeMs > newest) newest = s.mtimeMs;
			} catch {
				// Ignore unreadable entries — best-effort freshness check.
			}
		}
		const ageMs = Date.now() - newest;
		const STALE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
		if (newest > 0 && ageMs > STALE_MS) {
			return {
				kind: 'warning',
				message: `The last backup was ${formatRelativeTime(new Date(newest))}.`,
			};
		}
		return null;
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			'Home: backup banner probe failed',
		);
		return null;
	}
}

async function checkOllamaBanner(
	config: SystemConfig,
	logger: Logger,
): Promise<AttentionBanner | null> {
	if (!config.ollama) return null;
	try {
		const response = await fetch(config.ollama.url, { signal: AbortSignal.timeout(3000) });
		if (!response.ok) {
			return { kind: 'warning', message: "The local AI provider (Ollama) isn't responding." };
		}
		return null;
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			'Home: Ollama banner probe failed',
		);
		return { kind: 'warning', message: "The local AI provider (Ollama) isn't responding." };
	}
}

export function registerDashboardRoutes(server: FastifyInstance, options: DashboardOptions): void {
	const {
		registry,
		scheduler,
		config,
		modelSelector,
		dataDir,
		logger,
		alertService,
		reportService,
	} = options;

	server.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
		const actor = request.user;
		const isAdmin = Boolean(actor?.isPlatformAdmin);

		// ---- Attention banners (admin-only system health) ----
		const banners: AttentionBanner[] = [];
		if (isAdmin) {
			const [backupBanner, ollamaBanner] = await Promise.all([
				checkBackupBanner(config, logger),
				checkOllamaBanner(config, logger),
			]);
			if (backupBanner) banners.push(backupBanner);
			if (ollamaBanner) banners.push(ollamaBanner);
		}

		// ---- Glance metrics (scoped unless admin) ----
		let monthCost = 0;
		try {
			const content = await readFile(join(dataDir, 'system', 'llm-usage.md'), 'utf-8');
			if (content.trim()) {
				const { rows } = parseUsageMarkdown(content);
				const scopedRows = isAdmin ? rows : rows.filter((r) => r.user === actor?.userId);
				const thisMonth = new Date().toISOString().slice(0, 7);
				for (const row of scopedRows) {
					if (row.timestamp.startsWith(thisMonth)) {
						monthCost += Number.parseFloat(row.cost) || 0;
					}
				}
				monthCost = Math.round(monthCost * 1e6) / 1e6;
			}
		} catch {
			// No usage log yet — $0 spend, not an error.
		}

		let activeAlertsCount = 0;
		if (alertService) {
			try {
				const alerts = await alertService.listAlerts();
				const scoped = isAdmin
					? alerts
					: alerts.filter((a) => a.delivery.includes(actor?.userId ?? ''));
				activeAlertsCount = scoped.filter((a) => a.enabled).length;
			} catch (error) {
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					'Home: active-alerts glance failed',
				);
			}
		}

		let nextReportLine = 'No reports scheduled';
		if (reportService) {
			try {
				const reports = await reportService.listReports();
				const scoped = isAdmin
					? reports
					: reports.filter((r) => r.delivery.includes(actor?.userId ?? ''));
				const enabled = scoped.filter((r) => r.enabled);
				let soonest: { name: string; next: Date } | undefined;
				for (const r of enabled) {
					const next = getNextRun(r.schedule, config.timezone);
					if (next && (!soonest || next < soonest.next)) {
						soonest = { name: r.name, next };
					}
				}
				if (soonest) {
					nextReportLine = `${escapeHtml(soonest.name)}: ${formatRelativeTime(soonest.next)}`;
				}
			} catch (error) {
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					'Home: next-report glance failed',
				);
			}
		}

		// ---- Recent activity snippet (last 5 entries, scoped unless admin) ----
		type ActivityItem = { app: string; file: string; verb: string };
		let activity: ActivityItem[] = [];
		try {
			const changeLogPath = join(dataDir, 'system', 'change-log.jsonl');
			const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
			const changes = await collectChanges(changeLogPath, sevenDaysAgo);
			const scopedEntries = isAdmin
				? changes.entries
				: changes.entries.filter((e) => e.userId === actor?.userId);
			activity = scopedEntries
				.slice(-5)
				.reverse()
				.map((e) => ({
					app: e.appId,
					file: e.path.split('/').pop() ?? e.path,
					verb: e.operation === 'write' || e.operation === 'append' ? 'updated' : e.operation,
				}));
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				'Home: activity snippet failed',
			);
		}

		const noAttentionNeeded = banners.length === 0;

		return reply.viewAsync('home', {
			title: 'Home — PAS',
			activePage: 'dashboard',
			isAdmin,
			banners,
			noAttentionNeeded,
			monthCost: monthCost.toFixed(2),
			activeAlertsCount,
			nextReportLine,
			activity,
			uptime: formatUptime(process.uptime()),
			appCount: registry.getLoadedAppIds().length,
			cronJobCount: scheduler.cron.getJobDetails().length,
			claudeModel: modelSelector.getStandardRef().model,
			charts: chartsForPage('home'),
		});
	});
}
