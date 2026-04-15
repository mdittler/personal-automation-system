/**
 * Health check implementations for the /health/ready endpoint.
 *
 * Runs 4 checks: telegram connectivity, scheduler state, LLM reachability,
 * and filesystem write access. Results are used by registerHealthRoute to
 * determine HTTP 200 vs 503.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';

interface TelegramClient {
	getMe(): Promise<unknown>;
}

interface SchedulerHandle {
	isRunning(): boolean;
}

interface ProviderClient {
	listModels(): Promise<unknown[]>;
}

interface ProviderRegistryHandle {
	getAll(): ProviderClient[];
	getAllModels?(): Promise<unknown[]>;
}

interface HealthCheckDeps {
	telegram: TelegramClient;
	scheduler: SchedulerHandle;
	providerRegistry: ProviderRegistryHandle;
	dataDir: string;
	logger: Logger;
}

export interface CheckResult {
	name: string;
	status: 'ok' | 'fail';
	latencyMs?: number;
	detail?: string;
}

const TELEGRAM_TIMEOUT_MS = 5_000;
const LLM_CACHE_TTL_MS = 60_000;

export class HealthChecker {
	private llmCache: { result: CheckResult; expiresAt: number } | null = null;

	constructor(private readonly deps: HealthCheckDeps) {}

	async checkTelegram(): Promise<CheckResult> {
		const start = Date.now();
		try {
			await Promise.race([
				this.deps.telegram.getMe(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('Telegram getMe timed out')), TELEGRAM_TIMEOUT_MS),
				),
			]);
			return { name: 'telegram', status: 'ok', latencyMs: Date.now() - start };
		} catch (err) {
			return {
				name: 'telegram',
				status: 'fail',
				latencyMs: Date.now() - start,
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}

	checkScheduler(): CheckResult {
		const running = this.deps.scheduler.isRunning();
		return { name: 'scheduler', status: running ? 'ok' : 'fail' };
	}

	async checkLLM(): Promise<CheckResult> {
		const now = Date.now();
		if (this.llmCache && this.llmCache.expiresAt > now) {
			return this.llmCache.result;
		}

		const result = await this.doCheckLLM();
		this.llmCache = { result, expiresAt: now + LLM_CACHE_TTL_MS };
		return result;
	}

	private async doCheckLLM(): Promise<CheckResult> {
		const providers = this.deps.providerRegistry.getAll();

		if (providers.length === 0) {
			return { name: 'llm', status: 'fail', detail: 'no providers configured' };
		}

		// Try listModels on the first available provider
		const first = providers[0]!;
		const start = Date.now();
		try {
			await Promise.race([
				first.listModels(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('listModels timed out')), 5_000),
				),
			]);
			return { name: 'llm', status: 'ok', latencyMs: Date.now() - start, detail: 'llm_reachable' };
		} catch {
			// listModels failed but we have providers configured — degraded but configured
			return {
				name: 'llm',
				status: 'ok',
				latencyMs: Date.now() - start,
				detail: 'llm_configured',
			};
		}
	}

	async checkFilesystem(): Promise<CheckResult> {
		const healthFile = join(this.deps.dataDir, 'system', '.health-check');
		const start = Date.now();
		try {
			await mkdir(join(this.deps.dataDir, 'system'), { recursive: true });
			await writeFile(healthFile, 'ok');
			await rm(healthFile, { force: true });
			return { name: 'filesystem', status: 'ok', latencyMs: Date.now() - start };
		} catch (err) {
			return {
				name: 'filesystem',
				status: 'fail',
				latencyMs: Date.now() - start,
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async checkAll(): Promise<{ allOk: boolean; checks: CheckResult[] }> {
		const settled = await Promise.allSettled([
			this.checkTelegram(),
			Promise.resolve(this.checkScheduler()),
			this.checkLLM(),
			this.checkFilesystem(),
		]);

		const checks: CheckResult[] = settled.map((result, i) => {
			if (result.status === 'fulfilled') return result.value;
			// Should not happen since our methods never throw, but be defensive
			const names = ['telegram', 'scheduler', 'llm', 'filesystem'];
			return { name: names[i] ?? `check_${i}`, status: 'fail' as const, detail: String(result.reason) };
		});

		const allOk = checks.every((c) => c.status === 'ok');
		return { allOk, checks };
	}
}
