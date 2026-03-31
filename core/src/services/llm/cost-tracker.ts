/**
 * LLM API cost tracker.
 *
 * Logs every LLM API call with token counts and estimated cost
 * to data/system/llm-usage.md (URS-LLM-005).
 *
 * Also maintains an in-memory monthly cost cache (per-app and global)
 * persisted to data/system/monthly-costs.yaml for LLMGuard enforcement.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { toISO } from '../../utils/date.js';
import { ensureDir } from '../../utils/file.js';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';
import { estimateCallCost } from './model-pricing.js';

export interface UsageEntry {
	timestamp: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	estimatedCost: number;
	appId?: string;
	/** Provider key (e.g. 'anthropic', 'openai'). */
	provider?: string;
	/** User ID from LLM request context. */
	userId?: string;
}

/** Shape of the monthly-costs.yaml persistence file. */
interface MonthlyCostData {
	month: string;
	apps: Record<string, number>;
	users: Record<string, number>;
	total: number;
}

/** Minimum interval between YAML persistence writes (ms). */
const PERSIST_DEBOUNCE_MS = 10_000;

export class CostTracker {
	private readonly usageFilePath: string;
	private readonly monthlyCostPath: string;
	private readonly logger: Logger;
	/** Write queue to serialize file operations and prevent race conditions. */
	private writeQueue: Promise<void> = Promise.resolve();

	// Monthly cost cache
	private monthlyCosts = new Map<string, number>();
	private monthlyUserCosts = new Map<string, number>();
	private monthlyTotal = 0;
	private currentMonth = '';
	private persistDirty = false;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(dataDir: string, logger: Logger) {
		this.usageFilePath = join(dataDir, 'system', 'llm-usage.md');
		this.monthlyCostPath = join(dataDir, 'system', 'monthly-costs.yaml');
		this.logger = logger;
	}

	/**
	 * Load the monthly cost cache from disk. Call once at startup.
	 */
	async loadMonthlyCache(): Promise<void> {
		this.currentMonth = getCurrentMonth();
		try {
			const data = await readYamlFile<MonthlyCostData>(this.monthlyCostPath);
			if (data && data.month === this.currentMonth) {
				for (const [appId, cost] of Object.entries(data.apps ?? {})) {
					if (typeof cost === 'number') {
						this.monthlyCosts.set(appId, cost);
					}
				}
				for (const [userId, cost] of Object.entries(data.users ?? {})) {
					if (typeof cost === 'number') {
						this.monthlyUserCosts.set(userId, cost);
					}
				}
				this.monthlyTotal = typeof data.total === 'number' ? data.total : 0;
				this.logger.info(
					{ month: this.currentMonth, total: this.monthlyTotal, apps: this.monthlyCosts.size },
					'Monthly cost cache loaded',
				);
			} else {
				this.logger.info(
					{ month: this.currentMonth },
					'Monthly cost cache reset (new month or missing file)',
				);
			}
		} catch {
			this.logger.warn('Failed to load monthly cost cache, starting fresh');
		}
	}

	/**
	 * Get the accumulated monthly cost for a specific app.
	 */
	getMonthlyAppCost(appId: string): number {
		this.checkMonthRollover();
		return this.monthlyCosts.get(appId) ?? 0;
	}

	/**
	 * Get the total accumulated monthly cost across all apps.
	 */
	getMonthlyTotalCost(): number {
		this.checkMonthRollover();
		return this.monthlyTotal;
	}

	/**
	 * Get all per-app monthly costs as a Map (defensive copy).
	 */
	getMonthlyAppCosts(): Map<string, number> {
		this.checkMonthRollover();
		return new Map(this.monthlyCosts);
	}

	/**
	 * Get all per-user monthly costs as a Map (defensive copy).
	 */
	getMonthlyUserCosts(): Map<string, number> {
		this.checkMonthRollover();
		return new Map(this.monthlyUserCosts);
	}

	/**
	 * Get the accumulated monthly cost for a specific user.
	 */
	getMonthlyUserCost(userId: string): number {
		this.checkMonthRollover();
		return this.monthlyUserCosts.get(userId) ?? 0;
	}

	/**
	 * Estimate the cost of an LLM API call.
	 */
	estimateCost(model: string, inputTokens: number, outputTokens: number): number {
		return estimateCallCost(model, inputTokens, outputTokens);
	}

	/**
	 * Record an LLM API usage entry.
	 */
	async record(entry: Omit<UsageEntry, 'timestamp' | 'estimatedCost'>): Promise<void> {
		const estimatedCost = this.estimateCost(entry.model, entry.inputTokens, entry.outputTokens);

		if (estimatedCost === 0 && entry.model) {
			this.logger.warn(
				{ model: entry.model, provider: entry.provider },
				'Unknown model pricing — cost tracked as $0',
			);
		}

		const usageEntry: UsageEntry = {
			timestamp: toISO(),
			estimatedCost,
			...entry,
		};

		// Update in-memory monthly cost cache
		this.updateMonthlyCache(entry.appId, estimatedCost, entry.userId);

		try {
			await this.appendEntry(usageEntry);
			this.logger.debug(
				{
					provider: entry.provider,
					model: entry.model,
					inputTokens: entry.inputTokens,
					outputTokens: entry.outputTokens,
					estimatedCost,
				},
				'LLM API usage recorded',
			);
		} catch (err) {
			this.logger.error(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to record LLM usage',
			);
		}
	}

	/**
	 * Read the current usage file content.
	 */
	async readUsage(): Promise<string> {
		try {
			return await readFile(this.usageFilePath, 'utf-8');
		} catch {
			return '';
		}
	}

	/**
	 * Flush pending monthly cost data to disk and stop the debounce timer.
	 * Call on shutdown to avoid losing cached cost data.
	 */
	async flush(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		if (this.persistDirty) {
			await this.persistMonthlyCosts();
		}
	}

	private updateMonthlyCache(
		appId: string | undefined,
		cost: number,
		userId: string | undefined,
	): void {
		this.checkMonthRollover();
		if (appId) {
			const current = this.monthlyCosts.get(appId) ?? 0;
			this.monthlyCosts.set(appId, Math.round((current + cost) * 1e6) / 1e6);
		}
		if (userId) {
			const current = this.monthlyUserCosts.get(userId) ?? 0;
			this.monthlyUserCosts.set(userId, Math.round((current + cost) * 1e6) / 1e6);
		}
		this.monthlyTotal = Math.round((this.monthlyTotal + cost) * 1e6) / 1e6;
		this.schedulePersist();
	}

	private checkMonthRollover(): void {
		const now = getCurrentMonth();
		if (now !== this.currentMonth) {
			// Persist the old month's data before clearing (best-effort, fire-and-forget)
			if (this.persistDirty) {
				this.persistMonthlyCosts().catch(() => {});
			}
			this.monthlyCosts.clear();
			this.monthlyUserCosts.clear();
			this.monthlyTotal = 0;
			this.currentMonth = now;
			this.schedulePersist();
		}
	}

	private schedulePersist(): void {
		this.persistDirty = true;
		if (!this.persistTimer) {
			this.persistTimer = setTimeout(() => {
				this.persistTimer = null;
				this.persistMonthlyCosts().catch((err: unknown) => {
					this.logger.error(
						{ error: err instanceof Error ? err.message : String(err) },
						'Failed to persist monthly costs',
					);
				});
			}, PERSIST_DEBOUNCE_MS);
			if (this.persistTimer.unref) {
				this.persistTimer.unref();
			}
		}
	}

	private async persistMonthlyCosts(): Promise<void> {
		this.persistDirty = false;
		const data: MonthlyCostData = {
			month: this.currentMonth,
			apps: Object.fromEntries(this.monthlyCosts),
			users: Object.fromEntries(this.monthlyUserCosts),
			total: this.monthlyTotal,
		};
		try {
			await writeYamlFile(this.monthlyCostPath, data);
		} catch (err) {
			this.logger.error(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to write monthly-costs.yaml',
			);
		}
	}

	private appendEntry(entry: UsageEntry): Promise<void> {
		// Serialize writes through a promise chain to prevent race conditions
		// (concurrent record() calls can't interleave read-then-write)
		this.writeQueue = this.writeQueue.then(() => this.doAppendEntry(entry));
		return this.writeQueue;
	}

	private async doAppendEntry(entry: UsageEntry): Promise<void> {
		await ensureDir(dirname(this.usageFilePath));

		// Check if file exists and has content
		let content: string;
		try {
			content = await readFile(this.usageFilePath, 'utf-8');
		} catch {
			content = '';
		}

		// Initialize with header if empty
		if (!content.trim()) {
			const header = [
				'# LLM Usage Log',
				'',
				'| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App | User |',
				'|-----------|----------|-------|-------------|---------------|----------|-----|------|',
				'',
			].join('\n');
			await appendFile(this.usageFilePath, header, 'utf-8');
		}

		const safe = (v: string) => v.replace(/[|\n\r]/g, '_');
		const line = `| ${entry.timestamp} | ${safe(entry.provider ?? '-')} | ${safe(entry.model)} | ${entry.inputTokens} | ${entry.outputTokens} | ${entry.estimatedCost.toFixed(6)} | ${safe(entry.appId ?? '-')} | ${safe(entry.userId ?? '-')} |\n`;
		await appendFile(this.usageFilePath, line, 'utf-8');
	}
}

/** Get current month as YYYY-MM string. */
function getCurrentMonth(): string {
	return new Date().toISOString().slice(0, 7);
}
