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
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { parse as parseYaml } from 'yaml';
import type { ProviderType } from '../../types/llm.js';
import { PLATFORM_SYSTEM_HOUSEHOLD_ID } from '../../types/auth-actor.js';
import { toISO } from '../../utils/date.js';
import { atomicWrite, ensureDir } from '../../utils/file.js';
import { writeYamlFile } from '../../utils/yaml.js';
import { estimateCallCost, hasPricing } from './model-pricing.js';

export interface UsageEntry {
	timestamp: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	estimatedCost: number;
	appId?: string;
	/** Provider key (e.g. 'anthropic', 'openai'). */
	provider?: string;
	/** Provider backend type — used for pricing fallback (e.g. 'ollama' is free). */
	providerType?: ProviderType;
	/** User ID from LLM request context. */
	userId?: string;
	/** Household ID from LLM request context. Undefined or '__platform__' means no household attribution. */
	householdId?: string;
}

/** Shape of the monthly-costs.yaml persistence file. */
interface MonthlyCostData {
	month: string;
	apps: Record<string, number>;
	users: Record<string, number>;
	households?: Record<string, number>;
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
	private monthlyHouseholdCosts = new Map<string, number>();
	// Reservation state — populated in Task 3
	private reservations = new Map<string, {
		householdId: string;
		appId?: string;
		userId?: string;
		amount: number;
		expiresAt: number;
	}>();
	private reservationCleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(dataDir: string, logger: Logger) {
		this.usageFilePath = join(dataDir, 'system', 'llm-usage.md');
		this.monthlyCostPath = join(dataDir, 'system', 'monthly-costs.yaml');
		this.logger = logger;
	}

	/**
	 * Load the monthly cost cache from disk. Call once at startup.
	 *
	 * Three paths:
	 * (a) Valid YAML with matching month  → load from cache
	 * (b) Valid YAML with different month → rebuild from usage log (month rolled over)
	 * (c) Missing or corrupt YAML         → rebuild from usage log (or start fresh on clean install)
	 */
	async loadMonthlyCache(): Promise<void> {
		this.currentMonth = getCurrentMonth();

		// Attempt to read the YAML cache directly to distinguish missing vs corrupt
		let yamlLoaded = false;
		let fileMissing = false;

		try {
			const raw = await readFile(this.monthlyCostPath, 'utf-8');
			// File exists — try to parse it
			let data: MonthlyCostData | null = null;
			try {
				data = parseYaml(raw) as MonthlyCostData;
			} catch {
				this.logger.warn(
					{ path: this.monthlyCostPath },
					'Monthly cost cache YAML is malformed — will attempt rebuild from usage log',
				);
			}

			if (data && data.month === this.currentMonth) {
				// (a) Cache matches current month — load it
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
				yamlLoaded = true;
			} else if (data) {
				// (b) Cache is for a different month (month rolled over)
				this.logger.info(
					{ cached: data.month, current: this.currentMonth },
					'Monthly cost cache is from a different month — rebuilding from usage log',
				);
			}
			// If data is null (malformed), fall through to rebuild
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				fileMissing = true;
			} else {
				this.logger.warn(
					{ error: err instanceof Error ? err.message : String(err) },
					'Failed to read monthly cost cache — will attempt rebuild from usage log',
				);
			}
		}

		if (!yamlLoaded) {
			const rebuilt = await this.rebuildFromLog();
			if (rebuilt) {
				this.logger.info(
					{
						month: this.currentMonth,
						total: this.monthlyTotal,
						apps: this.monthlyCosts.size,
						users: this.monthlyUserCosts.size,
					},
					'Monthly cost cache rebuilt from usage log',
				);
				this.schedulePersist(); // Write back a fresh cache
			} else if (fileMissing) {
				this.logger.info(
					{ month: this.currentMonth },
					'Monthly cost cache starting fresh (clean install)',
				);
			} else {
				this.logger.info(
					{ month: this.currentMonth },
					'Monthly cost cache starting fresh (no current-month entries in usage log)',
				);
			}
		}
	}

	/**
	 * Rebuild monthly cost totals from the llm-usage.md append-only log.
	 * Returns true if any current-month entries were found.
	 */
	private async rebuildFromLog(): Promise<boolean> {
		let content: string;
		try {
			content = await readFile(this.usageFilePath, 'utf-8');
		} catch {
			return false; // No log file — clean install
		}

		if (!content.trim()) return false;

		// Reset accumulators so this method is idempotent (safe to call multiple times)
		this.monthlyCosts.clear();
		this.monthlyUserCosts.clear();
		this.monthlyHouseholdCosts.clear();
		this.monthlyTotal = 0;

		const lines = content.split('\n');
		let rebuilt = false;

		for (const line of lines) {
			// Match markdown table data rows: must start with '| 20' (timestamp prefix)
			if (!line.startsWith('| 20')) continue;

			const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
			// Expect: timestamp | provider | model | inputTokens | outputTokens | cost | app | user
			if (cells.length < 8) continue;

			const timestamp = cells[0]!; // e.g. "2026-04-10T14:30:00.000Z" (length >= 8 checked above)
			// Only count entries for the current month
			if (!timestamp.startsWith(this.currentMonth)) continue;

			const cost = parseFloat(cells[5]!);
			if (!Number.isFinite(cost) || cost < 0) continue;

			const appId = cells[6] === '-' ? undefined : cells[6];
			const userId = cells[7] === '-' ? undefined : cells[7];
			const householdId = cells.length >= 9 && cells[8] !== '-' ? cells[8] : undefined;

			if (appId) {
				const current = this.monthlyCosts.get(appId) ?? 0;
				this.monthlyCosts.set(appId, Math.round((current + cost) * 1e6) / 1e6);
			}
			if (userId) {
				const current = this.monthlyUserCosts.get(userId) ?? 0;
				this.monthlyUserCosts.set(userId, Math.round((current + cost) * 1e6) / 1e6);
			}
			if (householdId) {
				const current = this.monthlyHouseholdCosts.get(householdId) ?? 0;
				this.monthlyHouseholdCosts.set(householdId, Math.round((current + cost) * 1e6) / 1e6);
			}
			this.monthlyTotal = Math.round((this.monthlyTotal + cost) * 1e6) / 1e6;
			rebuilt = true;
		}

		return rebuilt;
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
	 * Get the accumulated monthly cost for a specific household (persisted + outstanding reservations).
	 */
	getMonthlyHouseholdCost(householdId: string): number {
		this.checkMonthRollover();
		const persisted = this.monthlyHouseholdCosts.get(householdId) ?? 0;
		const now = Date.now();
		let pending = 0;
		for (const r of this.reservations.values()) {
			if (r.householdId === householdId && r.expiresAt > now) pending += r.amount;
		}
		return Math.round((persisted + pending) * 1e6) / 1e6;
	}

	/**
	 * Get all per-household monthly costs as a Map (defensive copy, persisted only).
	 */
	getMonthlyHouseholdCosts(): Map<string, number> {
		this.checkMonthRollover();
		return new Map(this.monthlyHouseholdCosts);
	}

	/**
	 * Estimate the cost of an LLM API call.
	 */
	estimateCost(
		model: string,
		inputTokens: number,
		outputTokens: number,
		providerType?: ProviderType,
	): number {
		return estimateCallCost(model, inputTokens, outputTokens, providerType);
	}

	/**
	 * Record an LLM API usage entry.
	 */
	async record(entry: Omit<UsageEntry, 'timestamp' | 'estimatedCost'>): Promise<void> {
		const estimatedCost = this.estimateCost(
			entry.model,
			entry.inputTokens,
			entry.outputTokens,
			entry.providerType,
		);

		if (entry.model && !hasPricing(entry.model, entry.providerType)) {
			this.logger.warn(
				{ model: entry.model, provider: entry.provider, fallbackCost: estimatedCost },
				'Unknown model pricing — using conservative fallback estimate',
			);
		}

		const effectiveHouseholdId =
			entry.householdId && entry.householdId !== PLATFORM_SYSTEM_HOUSEHOLD_ID
				? entry.householdId
				: undefined;

		const usageEntry: UsageEntry = {
			timestamp: toISO(),
			estimatedCost,
			...entry,
			householdId: effectiveHouseholdId,  // override to strip __platform__
		};

		// Update in-memory monthly cost cache
		this.updateMonthlyCache(entry.appId, estimatedCost, entry.userId, effectiveHouseholdId);

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
		householdId: string | undefined,
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
		if (householdId) {
			const current = this.monthlyHouseholdCosts.get(householdId) ?? 0;
			this.monthlyHouseholdCosts.set(householdId, Math.round((current + cost) * 1e6) / 1e6);
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
			this.monthlyHouseholdCosts.clear();
			// Warn for any outstanding reservations that span a month boundary
			for (const [id, r] of this.reservations) {
				this.logger.warn(
					{ id, amount: r.amount, householdId: r.householdId },
					'Reservation cleared on month rollover',
				);
			}
			this.reservations.clear();
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
			households: Object.fromEntries(this.monthlyHouseholdCosts),
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
		// (concurrent record() calls can't interleave read-then-write).
		// Use .then(fn, fn) so a failed write does not poison the queue —
		// the tail always resolves, allowing subsequent entries to proceed.
		const p = this.writeQueue.then(
			() => this.doAppendEntry(entry),
			() => this.doAppendEntry(entry),
		);
		this.writeQueue = p.then(
			() => {},
			() => {},
		);
		return p;
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
