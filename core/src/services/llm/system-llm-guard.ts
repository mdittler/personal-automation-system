/**
 * System LLM Guard — lightweight global cost cap for infrastructure calls.
 *
 * Wraps the LLM service for infrastructure-level callers (router, daily diff,
 * condition evaluator) that are not associated with any app. Unlike LLMGuard,
 * this only checks the global monthly cost cap — no per-app rate limiting.
 *
 * Addresses deferred issue D3: infrastructure LLM calls previously bypassed
 * the global cost cap entirely.
 */

import type { Logger } from 'pino';
import type { ClassifyResult, LLMCompletionOptions, LLMService } from '../../types/llm.js';
import { classify } from './classify.js';
import type { CostTracker } from './cost-tracker.js';
import { LLMCostCapError } from './errors.js';
import { extractStructured } from './extract-structured.js';

export interface SystemLLMGuardOptions {
	/** The real LLM service to delegate to. */
	inner: LLMService;
	/** Cost tracker for monthly cost lookups. */
	costTracker: CostTracker;
	/** Global monthly cost cap in USD. */
	globalMonthlyCostCap: number;
	/** Logger instance. */
	logger: Logger;
	/** App ID to attribute costs to. Defaults to 'system'. */
	attributionId?: string;
}

export class SystemLLMGuard implements LLMService {
	private readonly inner: LLMService;
	private readonly costTracker: CostTracker;
	private readonly globalMonthlyCostCap: number;
	private readonly logger: Logger;
	private readonly attributionId: string;

	constructor(options: SystemLLMGuardOptions) {
		if (!Number.isFinite(options.globalMonthlyCostCap) || options.globalMonthlyCostCap <= 0) {
			throw new Error(
				`SystemLLMGuard: invalid globalMonthlyCostCap: ${options.globalMonthlyCostCap}`,
			);
		}
		this.inner = options.inner;
		this.costTracker = options.costTracker;
		this.globalMonthlyCostCap = options.globalMonthlyCostCap;
		this.logger = options.logger;
		this.attributionId = options.attributionId ?? 'system';
	}

	async complete(prompt: string, options?: LLMCompletionOptions): Promise<string> {
		this.checkGlobalCap();
		return this.inner.complete(prompt, { ...options, _appId: this.attributionId });
	}

	async classify(text: string, categories: string[]): Promise<ClassifyResult> {
		this.checkGlobalCap();
		const client = {
			complete: (prompt: string, opts?: LLMCompletionOptions) =>
				this.inner.complete(prompt, { ...opts, _appId: this.attributionId }),
		};
		return classify(text, categories, client, this.logger);
	}

	async extractStructured<T>(text: string, schema: object): Promise<T> {
		this.checkGlobalCap();
		const client = {
			complete: (prompt: string, opts?: LLMCompletionOptions) =>
				this.inner.complete(prompt, { ...opts, _appId: this.attributionId }),
		};
		return extractStructured<T>(text, schema, client, this.logger);
	}

	private checkGlobalCap(): void {
		const totalCost = this.costTracker.getMonthlyTotalCost();
		if (totalCost >= this.globalMonthlyCostCap) {
			this.logger.warn(
				{ totalCost, cap: this.globalMonthlyCostCap },
				`Global monthly LLM cost cap exceeded (${this.attributionId} call)`,
			);
			throw new LLMCostCapError({ scope: 'global', currentCost: totalCost, cap: this.globalMonthlyCostCap });
		}
	}
}
